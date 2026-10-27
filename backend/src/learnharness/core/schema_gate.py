"""Refuse Vault data written by a newer build (pure)."""

from __future__ import annotations

# Raise together with HarnessConfig.schema_version whenever .harness/ changes shape.
SUPPORTED_SCHEMA_VERSION = 2


class SchemaTooNew(RuntimeError):
    """The Vault was last written by a newer Lapidare; an older build must not touch it."""


def check_schema(found: int, supported: int = SUPPORTED_SCHEMA_VERSION) -> None:
    if found > supported:
        raise SchemaTooNew(
            f"Vault data uses schema {found}, but this Lapidare build supports up to "
            f"{supported}. Update the app, or restore a backup from .harness/backups/."
        )
