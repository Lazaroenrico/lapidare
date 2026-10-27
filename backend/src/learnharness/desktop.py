"""Entry point of the desktop build: ``python -m learnharness.desktop``.

The Electron shell picks the port (``LEARNHARNESS_PORT``) and reads the exit code to tell the
user why the backend could not start.
"""

from __future__ import annotations

import os
import sys

from learnharness.core.schema_gate import SchemaTooNew
from learnharness.vault.ownership import VaultBusy

EXIT_VAULT_BUSY = 75
EXIT_SCHEMA_TOO_NEW = 76
EXIT_BAD_ENV = 2


def exit_code_for(error: BaseException | None) -> int | None:
    if isinstance(error, VaultBusy):
        return EXIT_VAULT_BUSY
    if isinstance(error, SchemaTooNew):
        return EXIT_SCHEMA_TOO_NEW
    return None


def main() -> int:
    raw_port = os.environ.get("LEARNHARNESS_PORT", "")
    if not raw_port.isdigit() or not 0 < int(raw_port) < 65536:
        print("LEARNHARNESS_PORT must be set to a valid port.", file=sys.stderr)
        return EXIT_BAD_ENV

    import uvicorn

    # Imported only now: ``create_app()`` runs at import time and reads the environment.
    from learnharness.api.app import app
    from learnharness.api.state import get_app_state

    try:
        uvicorn.run(
            app,
            host="127.0.0.1",
            port=int(raw_port),
            timeout_graceful_shutdown=5,
            log_level="info",
        )
    except SystemExit:
        # uvicorn turns any lifespan startup failure into SystemExit(3).
        error = get_app_state(app).startup_error
        code = exit_code_for(error)
        if code is None:
            raise
        print(f"Lapidare backend could not start: {error}", file=sys.stderr)
        return code
    return 0


if __name__ == "__main__":
    sys.exit(main())
