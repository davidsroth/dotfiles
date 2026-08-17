#!/usr/bin/env python3
"""Apply the reviewed Herdr Pi v8 state patch without touching unknown files."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import UTC, datetime


BASE_SHA256 = "9b1c41cd72520fc2abe5f2a2aec995c12a926cce844df472c7fd5fcae4f4dbfa"
LEGACY_PATCHED_SHA256 = "74244056a82a5bc3b217c28940a1f6a43922e72922d0301065f4925d1cdeb8a0"
PATCHED_SHA256 = "68c8d03b7498595c5b32e97ad8093fa41b786326fb3d703fcfe05c0a68618ac5"
PATCHES_DIR = Path(__file__).resolve().parents[1] / "patches"
FIXTURE_PATH = PATCHES_DIR / "herdr-agent-state-v8.ts"
REQUIRED_HEADER = (
    "// installed by herdr",
    "// managed by herdr; reinstalling or updating the integration overwrites this file.",
    "// HERDR_INTEGRATION_ID=pi",
    "// HERDR_INTEGRATION_VERSION=8",
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def default_target() -> Path:
    agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR", "~/.pi/agent")).expanduser()
    return agent_dir / "extensions" / "herdr-agent-state.ts"


def verify_header(text: str, target: Path) -> None:
    missing = [line for line in REQUIRED_HEADER if line not in text]
    if missing:
        raise ValueError(
            f"{target} is not Herdr's managed Pi integration v8 (missing {missing[0]!r}). "
            "If Herdr reinstalled it, run 'just herdr-setup'; otherwise review the integration and refresh the tracked patch."
        )


def patch_status(target: Path) -> str:
    """Return the installed patch state, or fail with a safe remediation."""
    if not target.is_file():
        raise ValueError(
            f"{target} is absent. Install Herdr's Pi integration with 'herdr integration install pi', "
            "then run 'just herdr-setup' to apply the reviewed patch."
        )

    original = target.read_text(encoding="utf-8")
    verify_header(original, target)
    fingerprint = sha256(target)
    if fingerprint == PATCHED_SHA256:
        return "installed"
    if fingerprint == BASE_SHA256:
        return "stock"
    if fingerprint == LEGACY_PATCHED_SHA256:
        return "legacy"
    raise ValueError(
        f"{target} does not match the reviewed Herdr Pi v8 patch ({fingerprint}). "
        "If it was overwritten, run 'just herdr-setup'; otherwise review the integration and refresh "
        "the tracked patch before retrying."
    )


def check_patch(target: Path) -> str:
    """Verify the patch is installed without modifying the target."""
    status = patch_status(target)
    if status == "installed":
        return "installed"
    if status == "legacy":
        raise ValueError(
            f"{target} has the exact legacy Herdr Pi v8 patch; migration required. "
            "Run 'just herdr-setup'."
        )
    raise ValueError(
        f"{target} is the stock Herdr Pi v8 integration. "
        "'herdr integration install pi' overwrites this patch; run 'just herdr-setup'."
    )


def build_patched_target(temporary: Path, patch_file: Path) -> None:
    """Build the reviewed target from the tracked stock fixture, never an installed patch."""
    if sha256(FIXTURE_PATH) != BASE_SHA256:
        raise ValueError(
            "The tracked Herdr Pi v8 fixture failed its expected fingerprint; refusing to modify the managed integration."
        )

    result = subprocess.run(
        ["patch", "--batch", "--forward", "--silent", "--output", str(temporary), str(FIXTURE_PATH)],
        input=patch_file.read_text(encoding="utf-8"),
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError(
            "The reviewed Herdr Pi patch did not apply cleanly to the tracked fixture; refusing to modify "
            f"the managed integration. Review and refresh {patch_file.name}. {result.stderr.strip()}"
        )
    if sha256(temporary) != PATCHED_SHA256:
        raise ValueError(
            "Patched output failed its expected fingerprint; refusing to modify the managed integration."
        )


def apply_patch(target: Path, patch_file: Path) -> str:
    status = patch_status(target)
    if status == "installed":
        return "already applied"

    fd, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".patched", dir=target.parent)
    temporary = Path(temporary_name)
    os.close(fd)
    try:
        build_patched_target(temporary, patch_file)
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        backup = target.with_name(f"{target.name}.pre-dotfiles-patch-{timestamp}.bak")
        shutil.copy2(target, backup)
        os.chmod(temporary, stat.S_IMODE(target.stat().st_mode))
        os.replace(temporary, target)
        if status == "legacy":
            return f"migrated legacy patch (backup: {backup})"
        return f"applied (backup: {backup})"
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", type=Path, default=default_target(), help="managed Herdr Pi integration to patch")
    parser.add_argument("--check", action="store_true", help="verify the exact patched integration without modifying it")
    args = parser.parse_args(argv)
    patch_file = Path(__file__).resolve().parents[1] / "patches" / "herdr-pi-state-v8.patch"
    try:
        target = args.target.expanduser()
        result = check_patch(target) if args.check else apply_patch(target, patch_file)
        print(f"herdr-pi-state: {result}")
    except (OSError, ValueError) as error:
        print(f"herdr-pi-state: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
