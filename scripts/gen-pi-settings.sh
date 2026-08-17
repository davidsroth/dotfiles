#!/usr/bin/env bash
# Generate ~/.pi/agent/settings.json by merging:
#   1. existing live settings.json   (preserve pi's runtime writes, e.g. lastChangelogVersion)
#   2. settings.base.json            (tracked global settings: theme, packages, ...)
#   3. settings.local.json           (per-machine overrides: provider/model; gitignored)
# Later sources win per-key, so base/local override stale runtime values while
# runtime-only keys (not present in base/local) are preserved across regens.
#
# Usage: gen-pi-settings.sh [--quiet] [--check]
set -euo pipefail

QUIET=0
CHECK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet) QUIET=1 ;;
    --check) CHECK=1 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
log() { [[ "$QUIET" == 1 ]] || printf '%s\n' "$*"; }

# Resolve repo root from this script's location (scripts/ is at repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BASE="$REPO_ROOT/pi/.pi/agent/settings.base.json"
LOCAL="$HOME/.pi/agent/settings.local.json"
DEST="$HOME/.pi/agent/settings.json"

[[ -f "$BASE" ]] || { log "No settings.base.json at $BASE; skipping."; exit 0; }

mkdir -p "$(dirname "$DEST")"
local_package_prefix='../../dotfiles/'
local_overrides="$LOCAL"; [[ -f "$local_overrides" ]] || local_overrides=/dev/null

# Snapshot the live file before replacing DEST. This also preserves runtime
# keys when DEST is a stale stow symlink; the final mv replaces the link rather
# than writing through it.
existing="$(mktemp)"
tmp="$(mktemp)"
trap 'rm -f "$existing" "$tmp"' EXIT
if [[ -f "$DEST" ]]; then
  cat "$DEST" > "$existing"
else
  printf '{}\n' > "$existing"
fi

if command -v jq >/dev/null 2>&1; then
  jq -s --arg repo_root "$REPO_ROOT" --arg prefix "$local_package_prefix" '
    ((.[0] // {}) * (.[1] // {}) * (.[2] // {}))
    | if (.packages | type) == "array" then
        .packages |= map(
          if type == "string" and startswith($prefix) then
            $repo_root + "/" + ltrimstr($prefix)
          elif type == "object"
            and (.source | type) == "string"
            and (.source | startswith($prefix)) then
            .source = $repo_root + "/" + (.source | ltrimstr($prefix))
          else .
          end
        )
      else .
      end
  ' \
    "$existing" \
    "$BASE" \
    <(cat "$local_overrides" 2>/dev/null || printf '{}') \
    > "$tmp"
else
  command -v python3 >/dev/null 2>&1 || {
    log "jq and python3 not found; cannot generate settings safely."
    exit 1
  }
  log "jq not found; using python3 fallback for settings merge."
  python3 - "$existing" "$BASE" "$local_overrides" "$tmp" "$REPO_ROOT" "$local_package_prefix" <<'PY'
import json
import os
import sys

existing_path, base_path, local_path, destination, repo_root, prefix = sys.argv[1:]


def load(path):
    if path == "/dev/null":
        return {}
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def merge(left, right):
    if isinstance(left, dict) and isinstance(right, dict):
        result = dict(left)
        for key, value in right.items():
            result[key] = merge(result[key], value) if key in result else value
        return result
    return right


settings = merge(merge(load(existing_path), load(base_path)), load(local_path))
packages = settings.get("packages")
if isinstance(packages, list):
    rewritten_packages = []
    for package in packages:
        if isinstance(package, str) and package.startswith(prefix):
            package = os.path.join(repo_root, package[len(prefix):])
        elif (
            isinstance(package, dict)
            and isinstance(package.get("source"), str)
            and package["source"].startswith(prefix)
        ):
            package = dict(package)
            package["source"] = os.path.join(repo_root, package["source"][len(prefix):])
        rewritten_packages.append(package)
    settings["packages"] = rewritten_packages

with open(destination, "w", encoding="utf-8") as handle:
    json.dump(settings, handle, indent=2)
    handle.write("\n")
PY
fi

if [[ "$CHECK" == 1 ]]; then
  if [[ ! -f "$DEST" ]]; then
    log "Settings drift: $DEST does not exist."
    exit 3
  fi
  if python3 - "$tmp" "$DEST" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as expected, open(sys.argv[2], encoding="utf-8") as actual:
    raise SystemExit(0 if json.load(expected) == json.load(actual) else 3)
PY
  then
    log "Settings are current."
    exit 0
  else
    status=$?
    [[ "$status" == 3 ]] && log "Settings drift: run just pi-settings."
    exit "$status"
  fi
fi

mv "$tmp" "$DEST"
chmod 600 "$DEST"
rm -f "$existing"
trap - EXIT

if [[ "$local_overrides" == /dev/null ]]; then
  log "Generated $DEST from settings.base.json (no settings.local.json found)."
  log "Copy pi/.pi/agent/settings.local.json.example → $LOCAL for per-machine overrides."
else
  log "Generated $DEST (base + local merged, runtime keys preserved)."
fi
