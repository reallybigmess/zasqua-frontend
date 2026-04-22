#!/usr/bin/env python3
"""
Unit Tests for upload-to-r2.py Delete Safety Cap

These tests exercise the 5% safety cap on orphan deletes. The cap
aborts the delete pass whenever the fraction of remote keys that
would be deleted exceeds 5%, unless the operator passed
`--confirm-deletes`. Edge cases covered: the 4% / 6% boundary, the
confirm-flag override, empty delete sets, and the zero-remote-count
case that would otherwise divide by zero.

Run:
    pytest tests/upload-to-r2/ -v

Version: v1.0.0
"""

import pytest


@pytest.mark.parametrize("to_delete_count, remote_count, expected_proceed", [
    (6, 100, False),    # 6% without confirm → abort
    (4, 100, True),     # 4% without confirm → proceed
    (5, 100, True),     # exactly 5% → within cap, proceed
])
def test_cap_boundaries_without_confirm(upload_to_r2, to_delete_count,
                                        remote_count, expected_proceed):
    to_delete = [f"orphan-{i}.html" for i in range(to_delete_count)]
    proceed, returned = upload_to_r2.apply_safety_cap(
        to_delete, remote_count, confirm_deletes=False
    )
    assert proceed is expected_proceed
    assert returned == to_delete


def test_cap_trips_at_6_percent_without_confirm(upload_to_r2):
    to_delete = [f"orphan-{i}.html" for i in range(6)]
    proceed, returned = upload_to_r2.apply_safety_cap(
        to_delete, remote_count=100, confirm_deletes=False
    )
    assert proceed is False
    # The cap aborts; the list is still returned so the caller can print it
    # to stderr for operator review.
    assert len(returned) == 6


def test_cap_proceeds_at_4_percent_without_confirm(upload_to_r2):
    to_delete = [f"orphan-{i}.html" for i in range(4)]
    proceed, returned = upload_to_r2.apply_safety_cap(
        to_delete, remote_count=100, confirm_deletes=False
    )
    assert proceed is True
    assert len(returned) == 4


def test_cap_overridden_by_confirm_flag(upload_to_r2):
    # 20% deletion is well above the cap — --confirm-deletes should bypass
    # the check entirely.
    to_delete = [f"orphan-{i}.html" for i in range(20)]
    proceed, returned = upload_to_r2.apply_safety_cap(
        to_delete, remote_count=100, confirm_deletes=True
    )
    assert proceed is True
    assert len(returned) == 20


def test_cap_proceeds_at_empty_to_delete(upload_to_r2):
    # Nothing to delete → always proceed, regardless of the confirm flag.
    for confirm in (False, True):
        proceed, returned = upload_to_r2.apply_safety_cap(
            [], remote_count=1000, confirm_deletes=confirm
        )
        assert proceed is True
        assert returned == []


def test_cap_handles_zero_remote_count(upload_to_r2):
    # Empty bucket → no keys can orphan. We still want the helper to
    # return cleanly rather than raising ZeroDivisionError.
    proceed, returned = upload_to_r2.apply_safety_cap(
        [], remote_count=0, confirm_deletes=False
    )
    assert proceed is True
    assert returned == []
