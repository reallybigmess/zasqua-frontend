#!/usr/bin/env python3
"""
Unit Tests for upload-to-r2.py Bucket-to-Bucket Copy Mode

These tests exercise the `copy_objects_batch` helper that powers the
staging-to-production promotion workflow. The assertions cover the
happy path (every key copied), the missing-source case (a key in the
copy list that does not exist in the source bucket), the
metadata-preservation contract (ContentType carried across without
re-setting), and the empty-keys short-circuit.

moto's `mock_aws` replays the S3 API in process, so `copy_object`
runs against the same in-memory store the put_object fixture
populated. No real R2 credentials are touched.

Run:
    pytest tests/upload-to-r2/ -v

Version: v1.0.0
"""


def test_copy_objects_batch_copies_all(upload_to_r2, s3_client,
                                       src_bucket, dst_bucket):
    keys = [f"page-{i}.html" for i in range(5)]
    for k in keys:
        s3_client.put_object(
            Bucket=src_bucket,
            Key=k,
            Body=f"<html>{k}</html>".encode("utf-8"),
            ContentType="text/html",
        )
    result = upload_to_r2.copy_objects_batch(
        s3_client, src_bucket, dst_bucket, keys, concurrency=4
    )
    assert result["copied"] == 5
    assert result["failed"] == 0
    assert result["failed_keys"] == []
    # Spot-check one destination object exists.
    head = s3_client.head_object(Bucket=dst_bucket, Key=keys[0])
    assert head["ResponseMetadata"]["HTTPStatusCode"] == 200


def test_copy_objects_batch_handles_missing_src_key(upload_to_r2, s3_client,
                                                    src_bucket, dst_bucket):
    # Seed the source with only 1 of 3 keys; the other 2 should fail to
    # copy and be surfaced in failed_keys.
    s3_client.put_object(Bucket=src_bucket, Key="present.html",
                         Body=b"<html></html>")
    keys = ["present.html", "missing-a.html", "missing-b.html"]
    result = upload_to_r2.copy_objects_batch(
        s3_client, src_bucket, dst_bucket, keys, concurrency=2
    )
    assert result["copied"] == 1
    assert result["failed"] == 2
    failed_key_names = sorted(k for k, _ in result["failed_keys"])
    assert failed_key_names == ["missing-a.html", "missing-b.html"]


def test_copy_objects_batch_preserves_metadata(upload_to_r2, s3_client,
                                               src_bucket, dst_bucket):
    """copy_object with MetadataDirective unset defaults to COPY,
    which carries the source ContentType onto the destination."""
    s3_client.put_object(
        Bucket=src_bucket,
        Key="page.html",
        Body=b"<html><body>Hola</body></html>",
        ContentType="text/html",
        CacheControl="public, max-age=3600",
    )
    result = upload_to_r2.copy_objects_batch(
        s3_client, src_bucket, dst_bucket, ["page.html"], concurrency=1
    )
    assert result["copied"] == 1
    assert result["failed"] == 0
    dst_head = s3_client.head_object(Bucket=dst_bucket, Key="page.html")
    assert dst_head["ContentType"] == "text/html"
    assert dst_head["CacheControl"] == "public, max-age=3600"


def test_copy_objects_batch_empty_keys(upload_to_r2, s3_client,
                                       src_bucket, dst_bucket):
    result = upload_to_r2.copy_objects_batch(
        s3_client, src_bucket, dst_bucket, [], concurrency=4
    )
    assert result == {
        "copied": 0, "skipped": 0, "failed": 0, "failed_keys": [],
    }
