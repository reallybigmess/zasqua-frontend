#!/usr/bin/env python3
"""
Unit Tests for upload-to-r2.py Diff Helpers

These tests exercise the LIST + ETag diff pass and the multipart-ETag
guard added in the v1.0.0 cycle. They cover every branch of
`diff_files`, plus the paginated `list_remote_etags` helper which
must handle buckets large enough to overflow a single
`list_objects_v2` response (> 1000 keys) without losing entries.

Multipart-ETag guard semantics: R2 returns ETags wrapped in
double-quotes; boto3 strips those quotes. A single-part upload
produces a 32-character lowercase hex MD5; a multipart or
dashboard-uploaded object produces an ETag containing a dash. The
guard forces a re-upload whenever the remote ETag fails the
`^[0-9a-f]{32}$` regex — the tests assert each branch.

Run:
    pytest tests/upload-to-r2/ -v

Version: v1.0.0
"""


def test_diff_skips_matching_md5(upload_to_r2):
    local_files = [
        ("/tmp/a.html", "index.html", "a" * 32),
    ]
    remote_etags = {"index.html": "a" * 32}
    to_upload, to_skip, to_delete = upload_to_r2.diff_files(
        local_files, remote_etags
    )
    assert to_upload == []
    assert len(to_skip) == 1
    assert to_skip[0][1] == "index.html"
    assert to_delete == []


def test_diff_uploads_mismatched_md5(upload_to_r2):
    local_files = [
        ("/tmp/a.html", "index.html", "a" * 32),
    ]
    remote_etags = {"index.html": "b" * 32}
    to_upload, to_skip, to_delete = upload_to_r2.diff_files(
        local_files, remote_etags
    )
    assert len(to_upload) == 1
    assert to_upload[0][1] == "index.html"
    assert to_skip == []
    assert to_delete == []


def test_diff_uploads_missing_remote(upload_to_r2):
    local_files = [
        ("/tmp/a.html", "index.html", "a" * 32),
        ("/tmp/b.html", "about.html", "b" * 32),
    ]
    remote_etags = {}  # empty bucket
    to_upload, to_skip, to_delete = upload_to_r2.diff_files(
        local_files, remote_etags
    )
    assert len(to_upload) == 2
    keys = sorted(k for _, k, _ in to_upload)
    assert keys == ["about.html", "index.html"]
    assert to_skip == []
    assert to_delete == []


def test_diff_flags_multipart_etag_as_changed(upload_to_r2):
    """multipart composite ETag (contains '-') must force a
    re-upload even when the local MD5 happens to match the hex prefix."""
    local_files = [
        ("/tmp/big.json", "big.json", "a" * 32),
    ]
    # Multipart ETag: 32-hex-prefix + '-' + part count. Even if the hex
    # prefix byte-matches the local MD5, the regex fails → force re-upload.
    remote_etags = {"big.json": "a" * 32 + "-4"}
    to_upload, to_skip, to_delete = upload_to_r2.diff_files(
        local_files, remote_etags
    )
    assert len(to_upload) == 1
    assert to_upload[0][1] == "big.json"
    assert to_skip == []


def test_diff_detects_deletes(upload_to_r2):
    local_files = [
        ("/tmp/a.html", "index.html", "a" * 32),
    ]
    remote_etags = {
        "index.html": "a" * 32,
        "stale-page.html": "b" * 32,
        "old/asset.png": "c" * 32,
    }
    to_upload, to_skip, to_delete = upload_to_r2.diff_files(
        local_files, remote_etags
    )
    assert to_upload == []
    assert len(to_skip) == 1
    assert sorted(to_delete) == ["old/asset.png", "stale-page.html"]


def test_list_remote_etags_paginates(upload_to_r2, s3_client, src_bucket):
    """moto paginates list_objects_v2 at 1000 keys by default — seed the
    bucket with 1500 keys and confirm every one comes back."""
    for i in range(1500):
        s3_client.put_object(
            Bucket=src_bucket,
            Key=f"page-{i:05d}.html",
            Body=b"<html></html>",
        )
    result = upload_to_r2.list_remote_etags(s3_client, src_bucket)
    assert len(result) == 1500
    assert "page-00000.html" in result
    assert "page-01499.html" in result
    # Every ETag is a 32-char hex MD5 because moto uploads are single-part.
    for etag in result.values():
        assert len(etag) == 32
        assert all(c in "0123456789abcdef" for c in etag)


def test_list_remote_etags_empty_bucket(upload_to_r2, s3_client, src_bucket):
    result = upload_to_r2.list_remote_etags(s3_client, src_bucket)
    assert result == {}
