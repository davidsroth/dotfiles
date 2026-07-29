#!/usr/bin/env python3
"""Publish the visible Alt+1..9 agent positions as sidebar metadata."""

from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
from pathlib import Path

SOURCE = "local.agent-indexes"
TOKEN = "shortcut"
LEGACY_TOKEN = "indexed_workspace"


def run(herdr: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [herdr, *args],
        text=True,
        capture_output=True,
        check=False,
    )


def main() -> int:
    herdr = os.environ.get("HERDR_BIN_PATH", "herdr")
    state_dir = Path(os.environ.get("HERDR_PLUGIN_STATE_DIR", "/tmp"))
    state_dir.mkdir(parents=True, exist_ok=True)

    # Several layout events can arrive together. Serialize refreshes so an
    # older snapshot cannot overwrite metadata from a newer one.
    with (state_dir / "refresh.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)

        result = run(herdr, "agent", "list")
        if result.returncode != 0:
            print(result.stderr, file=sys.stderr, end="")
            return result.returncode
        try:
            agents = json.loads(result.stdout)["result"]["agents"]
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            print(f"agent-indexes: invalid agent list: {error}", file=sys.stderr)
            return 1

        for position, agent in enumerate(agents, start=1):
            pane_id = agent.get("pane_id")
            if not pane_id:
                continue

            desired = str(position) if position <= 9 else None
            tokens = agent.get("tokens") or {}
            current = tokens.get(TOKEN)
            legacy = tokens.get(LEGACY_TOKEN)
            if current == desired and legacy is None:
                continue

            args = [
                "pane",
                "report-metadata",
                pane_id,
                "--source",
                SOURCE,
            ]
            if desired is None:
                args += ["--clear-token", TOKEN]
            else:
                args += ["--token", f"{TOKEN}={desired}"]
            if legacy is not None:
                args += ["--clear-token", LEGACY_TOKEN]

            updated = run(herdr, *args)
            if updated.returncode != 0:
                print(updated.stderr, file=sys.stderr, end="")
                return updated.returncode

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
