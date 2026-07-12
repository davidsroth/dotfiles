#!/usr/bin/env bash
# Scan the current tracked/untracked (non-ignored) tree without traversing build state.
set -euo pipefail

command -v gitleaks >/dev/null 2>&1 || {
  printf '%s\n' 'gitleaks is required (install it with Homebrew or run just install).' >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-secret-scan.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

python3 - "$repo_root" "$tmp" <<'PY'
from pathlib import Path
import shutil
import subprocess
import sys

root, destination = map(Path, sys.argv[1:])
files = subprocess.check_output(
    ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"]
)
for raw in files.split(b"\0"):
    if not raw:
        continue
    relative = Path(raw.decode("utf-8", "surrogateescape"))
    source = root / relative
    if not source.is_file():
        continue
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        target.symlink_to(source.readlink())
    else:
        shutil.copyfile(source, target)
PY

gitleaks dir --no-banner --redact "$tmp"
