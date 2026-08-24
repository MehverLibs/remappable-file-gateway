"""Exceptions shared by source consumers (delivery and hashing)."""
from __future__ import annotations


class HashError(Exception):
    code = "hash_failed"


class SourceStaleError(HashError):
    code = "source_stale"


class ChangedDuringHashError(HashError):
    code = "changed_during_hash"
