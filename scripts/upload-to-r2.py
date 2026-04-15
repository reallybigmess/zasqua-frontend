#!/usr/bin/env python3
"""
Parallel Upload to Cloudflare R2

This script takes the directory produced by the Eleventy build — normally
`_site/` — and uploads every file inside it to a Cloudflare R2 bucket,
which is the object store that backs the live Zasqua site. R2 is
Cloudflare's S3-compatible storage, so the script talks to it using the
standard AWS `boto3` library pointed at Cloudflare's endpoint.

A Zasqua build produces tens of thousands of small HTML pages — one for
every archival description — plus the Pagefind search index, CSS, JS,
and image assets. Uploading them one at a time takes an impractically
long time, so this script walks the source tree once, then hands every
file off to a thread pool (100 workers by default) that streams them to
R2 in parallel. On each upload the script sets the `Content-Type` based
on the file extension and applies a `Cache-Control` header that matches
what the edge Worker (`worker/worker.js`) sends to visitors: short-lived
for HTML and JSON, week-long for CSS and JS, and a year with the
`immutable` flag for fonts and images.

Before the parallel phase begins the script uploads one file on its own
as a connection test. If credentials or networking are wrong it fails
fast with a clear error instead of burying the problem under a thousand
concurrent failures.

Pipeline context:
    Runs after `npx eleventy` and `npx pagefind` in the GitHub Actions
    deploy workflow (`.github/workflows/deploy.yml`). The `zasqua-site`
    bucket is read by the Cloudflare Worker in `worker/worker.js`, which
    serves the site to visitors.

Required environment variables:
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
    R2_ENDPOINT           — https://<account_id>.r2.cloudflarestorage.com

Usage:
    python3 scripts/upload-to-r2.py <source_dir> <bucket_name> [--concurrency N] [--dry-run]

Examples:
    python3 scripts/upload-to-r2.py _site zasqua-site --concurrency 100
    python3 scripts/upload-to-r2.py _site zasqua-tests --dry-run

Version: v0.3.2
"""

import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

print(f"[{time.strftime('%H:%M:%S')}] Importing boto3...", flush=True)
import boto3
from botocore.config import Config
print(f"[{time.strftime('%H:%M:%S')}] Imports complete", flush=True)

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
# Upload logic
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


def main():
    parser = argparse.ArgumentParser(description="Upload build output to R2")
    parser.add_argument("source_dir", help="Directory to upload (e.g. _site)")
    parser.add_argument("bucket", help="R2 bucket name (e.g. zasqua-site)")
    parser.add_argument("--concurrency", type=int, default=100,
                        help="Number of parallel uploads (default: 100)")
    parser.add_argument("--dry-run", action="store_true",
                        help="List files without uploading")
    args = parser.parse_args()

    source = Path(args.source_dir)
    if not source.is_dir():
        print(f"Error: {args.source_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    # Check environment
    endpoint = os.environ.get("R2_ENDPOINT")
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    if not args.dry_run and not all([endpoint, access_key, secret_key]):
        print("Error: R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY "
              "must be set", file=sys.stderr)
        sys.exit(1)

    # Collect files
    print(f"[{time.strftime('%H:%M:%S')}] Scanning {args.source_dir}...", flush=True)
    files = collect_files(args.source_dir)
    print(f"[{time.strftime('%H:%M:%S')}] Scan complete: {len(files):,} files", flush=True)
    total_size = sum(os.path.getsize(p) for p, _ in files)
    print(f"[{time.strftime('%H:%M:%S')}] Found {len(files):,} files ({total_size / 1e9:.2f} GB)", flush=True)

    if args.dry_run:
        print(f"Dry run — would upload {len(files):,} files to {args.bucket}", flush=True)
        # Show extension breakdown
        ext_counts = {}
        for _, key in files:
            ext = Path(key).suffix.lower() or "(no ext)"
            ext_counts[ext] = ext_counts.get(ext, 0) + 1
        for ext, count in sorted(ext_counts.items(), key=lambda x: -x[1])[:15]:
            print(f"  {ext}: {count:,}", flush=True)
        return

    # Create S3 client with retry config
    print(f"[{time.strftime('%H:%M:%S')}] Creating S3 client...", flush=True)
    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=Config(
            max_pool_connections=args.concurrency,
            retries={"max_attempts": 3, "mode": "adaptive"},
        ),
    )
    print(f"[{time.strftime('%H:%M:%S')}] S3 client created", flush=True)

    # Connection test — upload first file and report latency
    test_path, test_key = files[0]
    print(f"[{time.strftime('%H:%M:%S')}] Connection test: uploading {test_key}...",
          flush=True)
    t0 = time.monotonic()
    try:
        upload_file(s3, args.bucket, test_path, test_key)
        test_ms = (time.monotonic() - t0) * 1000
        print(f"[{time.strftime('%H:%M:%S')}] Connection test OK: {test_ms:.0f}ms",
              flush=True)
    except Exception as e:
        print(f"[{time.strftime('%H:%M:%S')}] Connection test FAILED: {e}",
              file=sys.stderr, flush=True)
        sys.exit(1)

    # Upload with thread pool
    print(f"[{time.strftime('%H:%M:%S')}] Uploading to {args.bucket} "
          f"with {args.concurrency} threads...", flush=True)
    start_time = time.monotonic()
    uploaded = 1  # count the connection test file
    failed = 0
    uploaded_bytes = os.path.getsize(test_path)
    errors = []

    remaining = files[1:]  # skip file already uploaded in connection test
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {
            pool.submit(upload_file, s3, args.bucket, path, key): key
            for path, key in remaining
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
                          f"{uploaded:,}/{len(files):,} files "
                          f"({uploaded_bytes / 1e9:.2f} GB, "
                          f"{rate:.0f} files/s)", flush=True)
            except Exception as e:
                failed += 1
                errors.append((key, str(e)))
                if failed <= 10:
                    print(f"  Error uploading {key}: {e}",
                          file=sys.stderr, flush=True)

    elapsed = time.monotonic() - start_time
    rate = uploaded / elapsed if elapsed > 0 else 0

    print(f"\nDone in {elapsed:.1f}s", flush=True)
    print(f"  Uploaded: {uploaded:,} files ({uploaded_bytes / 1e9:.2f} GB)",
          flush=True)
    print(f"  Failed: {failed:,}", flush=True)
    print(f"  Rate: {rate:.0f} files/s", flush=True)

    if failed > 0:
        print(f"\n{failed} errors:", file=sys.stderr, flush=True)
        for key, err in errors[:20]:
            print(f"  {key}: {err}", file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
