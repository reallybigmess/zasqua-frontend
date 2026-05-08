#!/usr/bin/env python3
"""
One-time Eleventy-era Orphan Prune

Background:
    The v1.0.0 cutover bound the prod Worker at zasqua.org to the
    `zasqua-staging` bucket (commit 887727a) to skip a class-A-heavy
    promote-copy during the Hugo switchover. When the first clean
    corpus-wide `promote-to-prod.yml` run landed it copied every Hugo
    object from `zasqua-staging` into `zasqua-site` and then hit the
    5% delete safety cap — 126,076 orphan keys of Eleventy-era content
    still sat in `zasqua-site` at paths Hugo no longer emits (Pagefind
    merged-index shards, old hashed CSS/JS, superseded data JSONs).
    Those orphans are functionally inert — the prod Worker only reads
    URLs it's asked for, and nothing links to the Eleventy paths — but
    they bloat R2 storage and confuse any future forensic listing of
    the prod bucket.

    This script diffs `zasqua-staging` (source of truth, what Hugo
    emits) against `zasqua-site` (prod) and deletes keys present in
    the latter but absent from the former. It is explicitly NOT wired
    into any workflow: it is an operator-dispatched one-shot, requires
    a literal `--confirm` gate (no equivalent of the 5% safety cap
    because the whole point is a large, intentional delete), and is
    expected to be retired after v1.0.0 is stable.

Semantics:
    * Reuses `list_remote_etags` from `upload-to-r2.py` for a single
      paginated LIST per bucket — same shape the promote workflow
      uses. The hyphen in the script filename prevents a normal
      `import`, so `importlib.import_module("upload-to-r2")` is used.
    * Parallelises `delete_object` across a 100-thread pool (the
      serial helper in `upload-to-r2.py` would take several hours on
      126K keys).
    * Emits the same grep-able summary line as `upload-to-r2.py` so
      log grepping stays uniform:
          r2-prune bucket=<name> pruned=<N> failed=<N> elapsed_s=<T>
    * `--dry-run` prints the plan and exits 0 without touching R2.

Required environment variables (same as upload-to-r2.py):
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
    R2_ENDPOINT           — https://<account_id>.r2.cloudflarestorage.com

Usage:
    python3 scripts/prune-eleventy-orphans.py --dry-run
    python3 scripts/prune-eleventy-orphans.py --confirm
    python3 scripts/prune-eleventy-orphans.py \
        --source-bucket zasqua-staging --target-bucket zasqua-site --confirm

Exit codes:
    0 — nothing to prune, dry-run completed, or all deletes succeeded.
    1 — one or more delete_object calls failed after the pool drained,
        or --confirm was omitted when orphans were present.

Version: v1.0.0
"""

import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

# Reuse the listing and S3-client helpers so semantics match the promote
# workflow byte-for-byte.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
_r2 = import_module("upload-to-r2")
list_remote_etags = _r2.list_remote_etags
_build_s3_client = _r2._build_s3_client


DEFAULT_SOURCE = "zasqua-staging"
DEFAULT_TARGET = "zasqua-site"
DEFAULT_CONCURRENCY = 100


def compute_orphans(src_keys, dst_keys):
    """Return the sorted list of keys present in dst but absent from src."""
    return sorted(set(dst_keys) - set(src_keys))


def delete_keys_parallel(s3, bucket, keys, concurrency):
    """Delete keys from bucket with a thread pool. Returns (deleted, failed,
    failed_keys). Errors are captured per-key and surfaced at the end so one
    bad key does not abort the batch."""
    deleted = 0
    failed = 0
    failed_keys = []

    def _delete(k):
        s3.delete_object(Bucket=bucket, Key=k)
        return k

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(_delete, k): k for k in keys}
        for i, fut in enumerate(as_completed(futures), 1):
            key = futures[fut]
            try:
                fut.result()
                deleted += 1
            except Exception as e:
                failed += 1
                failed_keys.append((key, str(e)))
            if i % 5000 == 0:
                print(
                    f"[{time.strftime('%H:%M:%S')}] Progress: "
                    f"{i:,}/{len(keys):,} ({deleted:,} ok, {failed:,} failed)",
                    flush=True,
                )

    return deleted, failed, failed_keys


def parse_args():
    p = argparse.ArgumentParser(
        description="Prune Eleventy-era orphans from the prod R2 bucket.",
    )
    p.add_argument("--source-bucket", default=DEFAULT_SOURCE,
                   help=f"Source of truth bucket (default: {DEFAULT_SOURCE})")
    p.add_argument("--target-bucket", default=DEFAULT_TARGET,
                   help=f"Bucket to prune (default: {DEFAULT_TARGET})")
    p.add_argument("--confirm", action="store_true",
                   help="Required to actually delete. Absent → print plan "
                        "and exit 1.")
    p.add_argument("--dry-run", action="store_true",
                   help="Print plan and exit 0 without deleting. Takes "
                        "precedence over --confirm.")
    p.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY,
                   help=f"Delete pool size (default: {DEFAULT_CONCURRENCY})")
    return p.parse_args()


def main():
    args = parse_args()

    endpoint = os.environ.get("R2_ENDPOINT")
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    missing = [n for n, v in (
        ("R2_ENDPOINT", endpoint),
        ("R2_ACCESS_KEY_ID", access_key),
        ("R2_SECRET_ACCESS_KEY", secret_key),
    ) if not v]
    if missing:
        print(f"Error: missing env vars: {', '.join(missing)}",
              file=sys.stderr, flush=True)
        return 2

    print(f"[{time.strftime('%H:%M:%S')}] Creating S3 client...", flush=True)
    s3 = _build_s3_client(endpoint, access_key, secret_key, args.concurrency)

    print(f"[{time.strftime('%H:%M:%S')}] Listing {args.source_bucket} "
          "(source of truth)...", flush=True)
    src_etags = list_remote_etags(s3, args.source_bucket)
    print(f"[{time.strftime('%H:%M:%S')}] Listing {args.target_bucket} "
          "(prune target)...", flush=True)
    dst_etags = list_remote_etags(s3, args.target_bucket)
    print(f"[{time.strftime('%H:%M:%S')}] "
          f"src={len(src_etags):,} keys, dst={len(dst_etags):,} keys",
          flush=True)

    orphans = compute_orphans(src_etags.keys(), dst_etags.keys())
    fraction = len(orphans) / max(len(dst_etags), 1) * 100
    print(f"[{time.strftime('%H:%M:%S')}] "
          f"Prune plan: orphans={len(orphans):,} "
          f"({fraction:.1f}% of {args.target_bucket})", flush=True)

    if not orphans:
        print(f"[{time.strftime('%H:%M:%S')}] Nothing to prune.", flush=True)
        print(f"r2-prune bucket={args.target_bucket} pruned=0 failed=0 "
              "elapsed_s=0.0", flush=True)
        return 0

    # Show first 20 + last 5 orphans so the operator can sanity-check the
    # path pattern before committing.
    preview_head = orphans[:20]
    preview_tail = orphans[-5:] if len(orphans) > 25 else []
    print(f"[{time.strftime('%H:%M:%S')}] Orphan sample:", flush=True)
    for k in preview_head:
        print(f"  {k}", flush=True)
    if preview_tail:
        print(f"  ... ({len(orphans) - 25:,} more) ...", flush=True)
        for k in preview_tail:
            print(f"  {k}", flush=True)

    if args.dry_run:
        elapsed = 0.0
        print(f"r2-prune mode=dry-run bucket={args.target_bucket} "
              f"would_prune={len(orphans)} elapsed_s={elapsed:.1f}",
              flush=True)
        return 0

    if not args.confirm:
        print(f"Error: --confirm required to delete {len(orphans):,} keys "
              f"from {args.target_bucket}. Re-run with --confirm when the "
              "plan above is correct.", file=sys.stderr, flush=True)
        return 1

    start = time.monotonic()
    print(f"[{time.strftime('%H:%M:%S')}] Deleting {len(orphans):,} orphan "
          f"keys from {args.target_bucket} with {args.concurrency} threads...",
          flush=True)
    deleted, failed, failed_keys = delete_keys_parallel(
        s3, args.target_bucket, orphans, args.concurrency,
    )
    elapsed = time.monotonic() - start

    for key, err in failed_keys[:20]:
        print(f"  Error deleting {key}: {err}", file=sys.stderr, flush=True)

    print(f"\nPrune done in {elapsed:.1f}s", flush=True)
    print(f"  Deleted: {deleted:,}", flush=True)
    print(f"  Failed:  {failed:,}", flush=True)
    print(f"r2-prune bucket={args.target_bucket} pruned={deleted} "
          f"failed={failed} elapsed_s={elapsed:.1f}", flush=True)

    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a") as f:
            f.write("\n### R2 prune\n\n")
            f.write("| bucket | pruned | failed | elapsed |\n")
            f.write("| --- | ---: | ---: | ---: |\n")
            f.write(f"| {args.target_bucket} | {deleted:,} | {failed:,} "
                    f"| {elapsed:.1f}s |\n")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
