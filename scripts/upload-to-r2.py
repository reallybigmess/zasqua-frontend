#!/usr/bin/env python3
"""
Upload the Hugo build output to Cloudflare R2 with high concurrency.

This script replaces rclone for full rebuilds. It walks the build output
directory (typically `_site/` or `public/`) and uploads every file to an
R2 bucket using boto3 with a thread pool. Content-Type and Cache-Control
headers are assigned per file extension so the bucket mirrors what the
serving Worker (`worker/worker.js`) expects — fonts immutable, images
immutable, HTML short, JSON medium, CSS and JavaScript long.

The script supports three modes layered on top of the original
full-upload path:

  1. Diff upload (default on). Before uploading, the script lists every
     key in the target bucket via `list_objects_v2`, compares each local
     file's MD5 hex digest against the remote ETag, and uploads only
     files whose contents have changed (plus any remote key whose ETag
     is not a clean 32-character hex string — those come from Cloudflare
     dashboard uploads or Wrangler and are re-uploaded to keep the diff
     honest). Orphan keys that exist in R2 but not in the local tree are
     deleted, subject to the 5% safety cap described below.

  2. Safety cap on deletions. If a diff would delete more than 5% of the
     bucket, the script aborts the delete pass, prints the list of
     would-be deletes to stderr, and exits with status 1. The operator
     re-runs with `--confirm-deletes` when the large delete is
     intentional (a bucket decommission, a data-model rename). Matches
     the "publishing is a deliberate act" doctrine.

  3. Bucket-to-bucket copy (`--copy-from <src>`). The staging →
     production promotion workflow uses this path to copy what was
     verified on staging.zasqua.org to zasqua.org bit-for-bit, without
     re-reading local files. boto3 `copy_object` is issued in a thread
     pool of the same shape as the upload pool; MetadataDirective is
     left unset so existing object metadata is preserved.

Every run emits a single grep-able structured summary line on stdout:

    r2-upload uploaded=<N> skipped=<N> deleted=<N> failed=<N> \\
        bytes_uploaded=<N> elapsed_s=<T> bucket=<name>

Copy mode adds `mode=copy`. Dry runs emit `mode=dry-run would_upload=<N>
would_delete=<N> would_skip=<N> bucket=<name>`. When
`GITHUB_STEP_SUMMARY` is set, the same counts are also appended as a
small markdown table so the workflow-run page carries them without
requiring a log-parse pass.

Both the copy pool and the delete pool print a timestamped line every
5,000 completions with completed/total counts, running files/sec rate,
and an ETA estimate on the copy path. Single-file upload mode reports
per-1,000 progress. This keeps the GitHub Actions log alive through
multi-minute corpus-scale passes instead of going silent between the
"Copy plan" header and "Copy done" footer. The delete pool is also
parallelised — a serial loop would take hours on a 126K-key prune.

Copy mode uses boto3 "standard" retry mode rather than "adaptive".
Adaptive mode's client-side rate limiter reads R2's `copy_object`
throttle signals as "back off" and caps throughput at roughly 77
keys/sec on a 100-thread pool, four times below the upload path.
Upload mode keeps adaptive — PUTs hit ~345 files/sec at 100 threads,
so adaptive is fine there.

Required environment variables:
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
    R2_ENDPOINT           — https://<account_id>.r2.cloudflarestorage.com

Usage:
    python3 scripts/upload-to-r2.py <source_dir> <bucket_name> \\
        [--diff | --no-diff] [--confirm-deletes] [--concurrency N] [--dry-run]
    python3 scripts/upload-to-r2.py --copy-from <src_bucket> <dst_bucket> \\
        [--confirm-deletes] [--concurrency N] [--dry-run]

Examples:
    python3 scripts/upload-to-r2.py _site zasqua-staging --concurrency 100
    python3 scripts/upload-to-r2.py _site zasqua-staging --no-diff
    python3 scripts/upload-to-r2.py --copy-from zasqua-staging zasqua-site
    python3 scripts/upload-to-r2.py _site zasqua-tests --dry-run

Version: v1.0.0
"""

import argparse
import hashlib
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
from botocore.config import Config

# ---------------------------------------------------------------------------
# Content-Type and Cache-Control — mirrors worker/worker.js
# ---------------------------------------------------------------------------

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".pf_meta": "application/octet-stream",
    ".pf_fragment": "application/octet-stream",
    ".pf_index": "application/octet-stream",
}

CACHE_CONTROL = {
    "short": "public, max-age=3600",          # html, xml, default
    "medium": "public, max-age=86400",         # json
    "long": "public, max-age=604800",          # css, js
    "immutable": "public, max-age=31536000, immutable",  # images, fonts
}

SHORT_EXTS = {".html", ".xml"}
MEDIUM_EXTS = {".json"}
LONG_EXTS = {".css", ".js"}
IMMUTABLE_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
    ".svg", ".woff", ".woff2", ".ttf",
}

# ETag guard. Single-part MD5 ETags returned by R2 are exactly 32
# lowercase hex characters (boto3 strips the surrounding quotes). Multipart
# composite ETags contain a dash (e.g. `abc123-4`) and cannot be compared
# against a local MD5 directly — any object whose ETag fails this regex is
# treated as "changed" and re-uploaded so a dashboard- or Wrangler-uploaded
# file cannot hide behind the diff.
_MD5_HEX_RE = re.compile(r"^[0-9a-f]{32}$")

# Safety cap — abort the delete pass if more than this fraction of the
# remote bucket would be deleted in a single run. Operator overrides with
# `--confirm-deletes` when the large delete is genuinely intentional.
_DELETE_SAFETY_CAP = 0.05


def content_type(path):
    ext = Path(path).suffix.lower()
    return CONTENT_TYPES.get(ext, "application/octet-stream")


def cache_control(path):
    ext = Path(path).suffix.lower()
    if ext in SHORT_EXTS:
        return CACHE_CONTROL["short"]
    if ext in MEDIUM_EXTS:
        return CACHE_CONTROL["medium"]
    if ext in LONG_EXTS:
        return CACHE_CONTROL["long"]
    if ext in IMMUTABLE_EXTS:
        return CACHE_CONTROL["immutable"]
    return CACHE_CONTROL["short"]


# ---------------------------------------------------------------------------
# File collection and hashing
# ---------------------------------------------------------------------------

def collect_files(source_dir):
    """Walk source_dir and return list of (local_path, r2_key) tuples."""
    source = Path(source_dir)
    files = []
    for path in source.rglob("*"):
        if path.is_file():
            key = str(path.relative_to(source))
            files.append((str(path), key))
    return files


def md5_hex(path, chunk_size=1024 * 1024):
    """Return the MD5 hex digest of a local file, streaming chunks to keep
    memory bounded for large sidecars."""
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Diff helpers (LIST + ETag compare)
# ---------------------------------------------------------------------------

def list_remote_etags(s3, bucket):
    """Paginate list_objects_v2 for bucket and return {key: etag}.

    ETags are returned with surrounding double-quotes stripped. Empty buckets
    (NoSuchBucket-adjacent) simply yield {}.
    """
    result = {}
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket):
        contents = page.get("Contents") or []
        for obj in contents:
            key = obj["Key"]
            etag = (obj.get("ETag") or "").strip('"')
            result[key] = etag
    return result


def diff_files(local_files, remote_etags):
    """Split local_files into (to_upload, to_skip, to_delete).

    Args:
        local_files: iterable of (local_path, key, md5_hex).
        remote_etags: dict {key: etag_without_quotes}.

    Returns:
        to_upload: list of (local_path, key, md5_hex) tuples whose local
            MD5 does not match the 32-hex remote ETag OR whose remote ETag
            is not a clean single-part MD5 (multipart guard) OR
            whose key is absent from the remote bucket.
        to_skip: list of tuples whose local MD5 matches the remote ETag
            and that remote ETag is a valid single-part MD5.
        to_delete: list of keys present in remote_etags but absent from
            the local file set.
    """
    local_keys = set()
    to_upload = []
    to_skip = []
    for path, key, digest in local_files:
        local_keys.add(key)
        remote_etag = remote_etags.get(key)
        if remote_etag is None:
            to_upload.append((path, key, digest))
            continue
        if not _MD5_HEX_RE.match(remote_etag):
            # Multipart composite ETag (contains "-") or otherwise
            # not a clean single-part MD5 → force re-upload.
            to_upload.append((path, key, digest))
            continue
        if digest == remote_etag:
            to_skip.append((path, key, digest))
        else:
            to_upload.append((path, key, digest))
    to_delete = [k for k in remote_etags.keys() if k not in local_keys]
    return to_upload, to_skip, to_delete


def apply_safety_cap(to_delete, remote_count, confirm_deletes):
    """Apply the 5% delete safety cap.

    Args:
        to_delete: list of keys that would be deleted.
        remote_count: total number of keys currently in the bucket.
        confirm_deletes: True if the operator passed --confirm-deletes.

    Returns:
        (proceed, to_delete): proceed is True if the delete pass should run,
        False if the cap tripped and the caller should abort (keeping the
        list around for stderr reporting).

    An empty to_delete list always proceeds. A zero remote_count always
    proceeds (there are no keys to delete, so division-by-zero is not a
    meaningful question).
    """
    if not to_delete:
        return (True, to_delete)
    if remote_count <= 0:
        return (True, to_delete)
    if confirm_deletes:
        return (True, to_delete)
    fraction = len(to_delete) / remote_count
    if fraction > _DELETE_SAFETY_CAP:
        return (False, to_delete)
    return (True, to_delete)


# ---------------------------------------------------------------------------
# Upload and copy primitives
# ---------------------------------------------------------------------------

def upload_file(s3_client, bucket, local_path, key, dry_run=False):
    """Upload a single file to R2. Returns (key, size, elapsed_ms)."""
    size = os.path.getsize(local_path)
    if dry_run:
        return (key, size, 0)
    start = time.monotonic()
    with open(local_path, "rb") as f:
        s3_client.put_object(
            Bucket=bucket,
            Key=key,
            Body=f,
            ContentType=content_type(key),
            CacheControl=cache_control(key),
        )
    elapsed = (time.monotonic() - start) * 1000
    return (key, size, elapsed)


def delete_keys_batch(s3_client, bucket, keys, concurrency=100):
    """Delete a list of keys from bucket using a thread pool (v0.5.0 —
    parallelised so corpus-scale delete passes finish in minutes rather
    than hours). Emits a timestamped progress line every 5,000
    completions with a running files/sec rate so long runs surface
    liveness in the workflow log. Returns (deleted, failed,
    failed_keys)."""
    deleted = 0
    failed = 0
    failed_keys = []
    if not keys:
        return (0, 0, [])

    def _delete_one(k):
        s3_client.delete_object(Bucket=bucket, Key=k)
        return k

    total = len(keys)
    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(_delete_one, k): k for k in keys}
        for i, future in enumerate(as_completed(futures), 1):
            key = futures[future]
            try:
                future.result()
                deleted += 1
            except Exception as e:
                failed += 1
                failed_keys.append((key, str(e)))
            if i % 5000 == 0:
                elapsed = time.monotonic() - start
                rate = i / elapsed if elapsed > 0 else 0
                print(f"  [{time.strftime('%H:%M:%S')}] "
                      f"{i:,}/{total:,} deletes "
                      f"({deleted:,} ok, {failed:,} failed, "
                      f"{rate:.0f} keys/s)", flush=True)
    return (deleted, failed, failed_keys)


def copy_objects_batch(s3, src_bucket, dst_bucket, keys, concurrency):
    """Run copy_object across keys with a thread pool.

    MetadataDirective is intentionally unset — boto3 defaults to COPY, which
    preserves the source object's existing ContentType and Cache-Control
    metadata on the destination.

    Returns a dict:
        {
            "copied": int,
            "skipped": int,
            "failed": int,
            "failed_keys": list of (key, error_str),
        }
    """
    copied = 0
    skipped = 0
    failed = 0
    failed_keys = []
    if not keys:
        return {
            "copied": 0, "skipped": 0, "failed": 0, "failed_keys": [],
        }

    def _copy_one(key):
        s3.copy_object(
            Bucket=dst_bucket,
            CopySource={"Bucket": src_bucket, "Key": key},
            Key=key,
        )
        return key

    total = len(keys)
    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(_copy_one, k): k for k in keys}
        for i, future in enumerate(as_completed(futures), 1):
            key = futures[future]
            try:
                future.result()
                copied += 1
            except Exception as e:
                failed += 1
                failed_keys.append((key, str(e)))
            # v0.5.0 — surface progress every 5,000 completions so the
            # workflow log stays alive through multi-minute copy passes.
            if i % 5000 == 0:
                elapsed = time.monotonic() - start
                rate = i / elapsed if elapsed > 0 else 0
                eta_s = (total - i) / rate if rate > 0 else 0
                print(f"  [{time.strftime('%H:%M:%S')}] "
                      f"{i:,}/{total:,} copies "
                      f"({copied:,} ok, {failed:,} failed, "
                      f"{rate:.0f} keys/s, ETA {eta_s / 60:.1f} min)",
                      flush=True)
    return {
        "copied": copied,
        "skipped": skipped,
        "failed": failed,
        "failed_keys": failed_keys,
    }


# ---------------------------------------------------------------------------
# Summary emission
# ---------------------------------------------------------------------------

def emit_summary(bucket, uploaded, skipped, deleted, failed,
                 bytes_uploaded, elapsed_s, mode=None):
    """Print the grep-able summary line. When $GITHUB_STEP_SUMMARY is
    set, also append a markdown table. mode='copy' or 'dry-run' add a
    `mode=<m>` key to differentiate without breaking the grep contract."""
    prefix = "r2-upload"
    if mode:
        line = (
            f"{prefix} mode={mode} "
            f"uploaded={uploaded} skipped={skipped} deleted={deleted} "
            f"failed={failed} bytes_uploaded={bytes_uploaded} "
            f"elapsed_s={elapsed_s:.1f} bucket={bucket}"
        )
    else:
        line = (
            f"{prefix} uploaded={uploaded} skipped={skipped} "
            f"deleted={deleted} failed={failed} "
            f"bytes_uploaded={bytes_uploaded} "
            f"elapsed_s={elapsed_s:.1f} bucket={bucket}"
        )
    print(line, flush=True)

    step_summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary_path:
        try:
            with open(step_summary_path, "a", encoding="utf-8") as f:
                f.write(f"\n### r2-upload — `{bucket}`")
                if mode:
                    f.write(f" (mode: `{mode}`)")
                f.write("\n\n| Metric | Count |\n|---|---|\n")
                f.write(f"| uploaded | {uploaded} |\n")
                f.write(f"| skipped | {skipped} |\n")
                f.write(f"| deleted | {deleted} |\n")
                f.write(f"| failed | {failed} |\n")
                f.write(f"| bytes_uploaded | {bytes_uploaded} |\n")
                f.write(f"| elapsed_s | {elapsed_s:.1f} |\n")
        except Exception as e:
            print(f"  Warning: could not write GITHUB_STEP_SUMMARY: {e}",
                  file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _build_s3_client(endpoint, access_key, secret_key, concurrency,
                     retry_mode="adaptive"):
    """Construct the boto3 S3 client. Extracted so both the upload and
    copy-from paths use the same shape. `retry_mode` is "adaptive"
    (default) for the upload path — boto3 adds a client-side rate
    limiter that backs off on any throttle signal, which plays nicely
    with R2's PUT path. Copy mode (`_main_copy_mode`) overrides to
    "standard" because R2's `copy_object` appears to return throttle
    signals at moderate concurrency that adaptive mode reads as "slow
    down" — switching to standard retries lets the pool saturate
    (adaptive mode capped at ~77 copies/sec on a 100-thread pool,
    4× below the upload-path PUT rate)."""
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=Config(
            max_pool_connections=concurrency,
            retries={"max_attempts": 3, "mode": retry_mode},
        ),
    )


def main():
    parser = argparse.ArgumentParser(
        description="Upload build output to R2 (with optional diff, "
                    "orphan delete, and bucket-to-bucket copy modes)"
    )
    # Post-parse validation handles the --copy-from vs source_dir mutual
    # exclusion — cleaner than a subparser here because the rest of the
    # flags apply identically to both paths.
    parser.add_argument("source_dir", nargs="?", default=None,
                        help="Directory to upload (required unless "
                             "--copy-from is set)")
    parser.add_argument("bucket",
                        help="Destination R2 bucket name")
    parser.add_argument("--concurrency", type=int, default=100,
                        help="Number of parallel uploads (default: 100)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Run the diff pass and print counts without "
                             "PUT/DELETE/COPY side effects")
    parser.add_argument("--diff", dest="diff", action="store_true",
                        default=True,
                        help="Enable LIST + ETag diff before upload "
                             "(default on)")
    parser.add_argument("--no-diff", dest="diff", action="store_false",
                        help="Disable the diff pass; full upload of every "
                             "file (restores v0.3.x behaviour)")
    parser.add_argument("--confirm-deletes", action="store_true",
                        default=False,
                        help="Override the 5%% delete safety cap. "
                             "Use when a bucket decommission or data-model "
                             "rename genuinely removes more than 5%% of "
                             "keys.")
    parser.add_argument("--copy-from", dest="copy_from", default=None,
                        metavar="SRC_BUCKET",
                        help="Copy-mode: copy every object from SRC_BUCKET "
                             "to the destination bucket, skipping keys "
                             "whose source and destination ETags match. "
                             "source_dir is not used in this mode.")
    args = parser.parse_args()

    # Mutual exclusion: copy-from ignores source_dir; plain upload requires it.
    if args.copy_from is None and args.source_dir is None:
        print("Error: source_dir is required unless --copy-from is set",
              file=sys.stderr)
        sys.exit(2)

    # Check environment — copy mode and real uploads both need R2 creds;
    # only a plain local-tree dry run can run without them.
    endpoint = os.environ.get("R2_ENDPOINT")
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    need_creds = not (args.dry_run and args.copy_from is None)
    if need_creds and not all([endpoint, access_key, secret_key]):
        print("Error: R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY "
              "must be set", file=sys.stderr)
        sys.exit(1)

    # ---- Copy mode ---------------------------------------------------------
    if args.copy_from is not None:
        return _main_copy_mode(args, endpoint, access_key, secret_key)

    # ---- Upload mode (default) --------------------------------------------
    return _main_upload_mode(args, endpoint, access_key, secret_key)


def _main_upload_mode(args, endpoint, access_key, secret_key):
    source = Path(args.source_dir)
    if not source.is_dir():
        print(f"Error: {args.source_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    # Collect files
    print(f"[{time.strftime('%H:%M:%S')}] Scanning {args.source_dir}...",
          flush=True)
    raw_files = collect_files(args.source_dir)
    print(f"[{time.strftime('%H:%M:%S')}] Scan complete: "
          f"{len(raw_files):,} files", flush=True)
    total_size = sum(os.path.getsize(p) for p, _ in raw_files)
    print(f"[{time.strftime('%H:%M:%S')}] Found {len(raw_files):,} files "
          f"({total_size / 1e9:.2f} GB)", flush=True)

    # If --diff (the default), we need MD5 digests for every local file so the
    # comparison against remote ETags can run. Streaming hashes are cheap
    # compared to the upload itself.
    if args.diff:
        print(f"[{time.strftime('%H:%M:%S')}] Computing local MD5 digests...",
              flush=True)
        local_files = [(p, k, md5_hex(p)) for p, k in raw_files]
    else:
        local_files = [(p, k, "") for p, k in raw_files]

    start_time = time.monotonic()

    # --dry-run path (no network side effects, but with creds we can still
    # LIST for a realistic preview)
    if args.dry_run and args.diff:
        if not all([endpoint, access_key, secret_key]):
            # Without creds, we can only report would_upload = total.
            elapsed = time.monotonic() - start_time
            print(
                f"r2-upload mode=dry-run would_upload={len(local_files)} "
                f"would_delete=0 would_skip=0 bucket={args.bucket}",
                flush=True,
            )
            return 0
        s3 = _build_s3_client(endpoint, access_key, secret_key,
                              args.concurrency)
        remote_etags = list_remote_etags(s3, args.bucket)
        to_upload, to_skip, to_delete = diff_files(local_files, remote_etags)
        print(
            f"r2-upload mode=dry-run would_upload={len(to_upload)} "
            f"would_delete={len(to_delete)} would_skip={len(to_skip)} "
            f"bucket={args.bucket}",
            flush=True,
        )
        return 0

    if args.dry_run and not args.diff:
        print(f"Dry run — would upload {len(local_files):,} files to "
              f"{args.bucket}", flush=True)
        print(
            f"r2-upload mode=dry-run would_upload={len(local_files)} "
            f"would_delete=0 would_skip=0 bucket={args.bucket}",
            flush=True,
        )
        return 0

    # Create S3 client with retry config
    print(f"[{time.strftime('%H:%M:%S')}] Creating S3 client...", flush=True)
    s3 = _build_s3_client(endpoint, access_key, secret_key, args.concurrency)
    print(f"[{time.strftime('%H:%M:%S')}] S3 client created", flush=True)

    # --- Diff pass ---------------------------------------------------------
    if args.diff:
        print(f"[{time.strftime('%H:%M:%S')}] Listing remote bucket "
              f"{args.bucket} for diff...", flush=True)
        remote_etags = list_remote_etags(s3, args.bucket)
        print(f"[{time.strftime('%H:%M:%S')}] Remote list complete: "
              f"{len(remote_etags):,} keys", flush=True)
        to_upload, to_skip, to_delete = diff_files(local_files, remote_etags)
        # Multipart-ETag warnings — one line per occurrence to stderr.
        for key, etag in remote_etags.items():
            if not _MD5_HEX_RE.match(etag) and key in {k for _, k, _ in to_upload}:
                print(f"multipart-etag-reupload key={key}",
                      file=sys.stderr, flush=True)
        print(f"[{time.strftime('%H:%M:%S')}] Diff: upload={len(to_upload):,} "
              f"skip={len(to_skip):,} delete={len(to_delete):,}", flush=True)
    else:
        to_upload = local_files
        to_skip = []
        to_delete = []
        remote_etags = {}

    # Connection test — against the first file queued for upload. If the
    # diff pass produced nothing to upload, skip the test (it is a latency
    # probe, not a correctness gate).
    uploaded = 0
    failed = 0
    uploaded_bytes = 0
    errors = []

    if to_upload:
        test_path, test_key, _ = to_upload[0]
        print(f"[{time.strftime('%H:%M:%S')}] Connection test: uploading "
              f"{test_key}...", flush=True)
        t0 = time.monotonic()
        try:
            upload_file(s3, args.bucket, test_path, test_key)
            test_ms = (time.monotonic() - t0) * 1000
            print(f"[{time.strftime('%H:%M:%S')}] Connection test OK: "
                  f"{test_ms:.0f}ms", flush=True)
            uploaded = 1
            uploaded_bytes = os.path.getsize(test_path)
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] Connection test FAILED: {e}",
                  file=sys.stderr, flush=True)
            sys.exit(1)
        remaining = to_upload[1:]
    else:
        print("r2-upload no changes detected, skipping connection test",
              flush=True)
        remaining = []

    # --- Upload pool -------------------------------------------------------
    if remaining:
        print(f"[{time.strftime('%H:%M:%S')}] Uploading to {args.bucket} "
              f"with {args.concurrency} threads...", flush=True)
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            futures = {
                pool.submit(upload_file, s3, args.bucket, path, key): key
                for path, key, _ in remaining
            }
            for future in as_completed(futures):
                key = futures[future]
                try:
                    _, size, _ = future.result()
                    uploaded += 1
                    uploaded_bytes += size
                    if uploaded % 1000 == 0:
                        elapsed = time.monotonic() - start_time
                        rate = uploaded / elapsed
                        print(f"  [{time.strftime('%H:%M:%S')}] "
                              f"{uploaded:,}/{len(to_upload):,} files "
                              f"({uploaded_bytes / 1e9:.2f} GB, "
                              f"{rate:.0f} files/s)", flush=True)
                except Exception as e:
                    failed += 1
                    errors.append((key, str(e)))
                    if failed <= 10:
                        print(f"  Error uploading {key}: {e}",
                              file=sys.stderr, flush=True)

    # --- Delete pass (subject to safety cap) -------------------------------
    deleted = 0
    cap_aborted = False
    if to_delete:
        proceed, delete_list = apply_safety_cap(
            to_delete, len(remote_etags), args.confirm_deletes
        )
        if not proceed:
            cap_aborted = True
            fraction = len(delete_list) / max(len(remote_etags), 1)
            print(
                f"Error: delete pass would remove {len(delete_list):,} of "
                f"{len(remote_etags):,} remote keys "
                f"({fraction * 100:.1f}% — exceeds 5% safety cap). Re-run "
                f"with --confirm-deletes to override.",
                file=sys.stderr, flush=True,
            )
            for k in delete_list:
                print(f"  would-delete: {k}", file=sys.stderr, flush=True)
        else:
            print(f"[{time.strftime('%H:%M:%S')}] Deleting "
                  f"{len(delete_list):,} orphan keys...", flush=True)
            deleted, del_failed, del_failed_keys = delete_keys_batch(
                s3, args.bucket, delete_list
            )
            failed += del_failed
            errors.extend(del_failed_keys)

    elapsed = time.monotonic() - start_time
    rate = uploaded / elapsed if elapsed > 0 else 0

    print(f"\nDone in {elapsed:.1f}s", flush=True)
    print(f"  Uploaded: {uploaded:,} files "
          f"({uploaded_bytes / 1e9:.2f} GB)", flush=True)
    print(f"  Skipped:  {len(to_skip):,} files "
          f"(already up to date)", flush=True)
    print(f"  Deleted:  {deleted:,} orphan keys", flush=True)
    print(f"  Failed:   {failed:,}", flush=True)
    print(f"  Rate:     {rate:.0f} files/s", flush=True)

    if failed > 0:
        print(f"\n{failed} errors:", file=sys.stderr, flush=True)
        for key, err in errors[:20]:
            print(f"  {key}: {err}", file=sys.stderr, flush=True)

    emit_summary(
        bucket=args.bucket,
        uploaded=uploaded,
        skipped=len(to_skip),
        deleted=deleted,
        failed=failed,
        bytes_uploaded=uploaded_bytes,
        elapsed_s=elapsed,
        mode=None,
    )

    if failed > 0 or cap_aborted:
        sys.exit(1)
    return 0


def _main_copy_mode(args, endpoint, access_key, secret_key):
    """Bucket-to-bucket copy. LIST src + dst, skip keys whose ETags
    already match, copy_object everything else, delete orphans on dst
    subject to the same 5% safety cap, emit the r2-upload summary line
    with mode=copy."""
    src_bucket = args.copy_from
    dst_bucket = args.bucket

    print(f"[{time.strftime('%H:%M:%S')}] Creating S3 client "
          "(copy mode uses standard retries to avoid adaptive "
          "mode's client-side rate limiter — see _build_s3_client "
          "docstring)...", flush=True)
    s3 = _build_s3_client(endpoint, access_key, secret_key,
                          args.concurrency, retry_mode="standard")

    print(f"[{time.strftime('%H:%M:%S')}] Listing {src_bucket}...", flush=True)
    src_etags = list_remote_etags(s3, src_bucket)
    print(f"[{time.strftime('%H:%M:%S')}] Listing {dst_bucket}...", flush=True)
    dst_etags = list_remote_etags(s3, dst_bucket)
    print(f"[{time.strftime('%H:%M:%S')}] src={len(src_etags):,} keys, "
          f"dst={len(dst_etags):,} keys", flush=True)

    start_time = time.monotonic()

    # Pre-filter: skip keys where src ETag equals dst ETag AND both are
    # clean single-part MD5s. Multipart ETags on either side force a copy
    # (matches the multipart-ETag semantics for the upload path).
    to_copy = []
    to_skip = []
    for key, src_etag in src_etags.items():
        dst_etag = dst_etags.get(key)
        if (dst_etag is not None
                and src_etag == dst_etag
                and _MD5_HEX_RE.match(src_etag)
                and _MD5_HEX_RE.match(dst_etag)):
            to_skip.append(key)
        else:
            to_copy.append(key)

    to_delete = [k for k in dst_etags.keys() if k not in src_etags]

    print(f"[{time.strftime('%H:%M:%S')}] Copy plan: copy={len(to_copy):,} "
          f"skip={len(to_skip):,} delete={len(to_delete):,}", flush=True)

    if args.dry_run:
        elapsed = time.monotonic() - start_time
        print(
            f"r2-upload mode=dry-run would_upload={len(to_copy)} "
            f"would_delete={len(to_delete)} would_skip={len(to_skip)} "
            f"bucket={dst_bucket}",
            flush=True,
        )
        return 0

    # --- Copy pool ---------------------------------------------------------
    print(f"[{time.strftime('%H:%M:%S')}] Copying {len(to_copy):,} objects "
          f"{src_bucket} -> {dst_bucket} with {args.concurrency} threads...",
          flush=True)
    copy_result = copy_objects_batch(
        s3, src_bucket, dst_bucket, to_copy, args.concurrency
    )
    copied = copy_result["copied"]
    failed = copy_result["failed"]
    failed_keys = copy_result["failed_keys"]

    for key, err in failed_keys[:20]:
        print(f"  Error copying {key}: {err}",
              file=sys.stderr, flush=True)

    # --- Delete pass on destination (subject to safety cap) ----------------
    deleted = 0
    cap_aborted = False
    if to_delete:
        proceed, delete_list = apply_safety_cap(
            to_delete, len(dst_etags), args.confirm_deletes
        )
        if not proceed:
            cap_aborted = True
            fraction = len(delete_list) / max(len(dst_etags), 1)
            print(
                f"Error: copy-mode delete pass would remove "
                f"{len(delete_list):,} of {len(dst_etags):,} destination "
                f"keys ({fraction * 100:.1f}% — exceeds 5% safety cap). "
                f"Re-run with --confirm-deletes to override.",
                file=sys.stderr, flush=True,
            )
            for k in delete_list:
                print(f"  would-delete: {k}", file=sys.stderr, flush=True)
        else:
            print(f"[{time.strftime('%H:%M:%S')}] Deleting "
                  f"{len(delete_list):,} orphan keys on {dst_bucket}...",
                  flush=True)
            deleted, del_failed, _ = delete_keys_batch(
                s3, dst_bucket, delete_list
            )
            failed += del_failed

    elapsed = time.monotonic() - start_time
    print(f"\nCopy done in {elapsed:.1f}s", flush=True)
    print(f"  Copied:   {copied:,} keys", flush=True)
    print(f"  Skipped:  {len(to_skip):,} keys (ETag match)", flush=True)
    print(f"  Deleted:  {deleted:,} orphan keys", flush=True)
    print(f"  Failed:   {failed:,}", flush=True)

    emit_summary(
        bucket=dst_bucket,
        uploaded=copied,
        skipped=len(to_skip),
        deleted=deleted,
        failed=failed,
        bytes_uploaded=0,
        elapsed_s=elapsed,
        mode="copy",
    )

    if failed > 0 or cap_aborted:
        sys.exit(1)
    return 0


if __name__ == "__main__":
    main()
