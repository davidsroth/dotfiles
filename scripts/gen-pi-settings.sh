#!/usr/bin/env bash
# Generate ~/.pi/agent/settings.json by merging:
#   1. existing live settings.json   (preserve pi's runtime writes, e.g. lastChangelogVersion)
#   2. settings.base.json            (tracked global settings: theme, packages, ...)
#   3. settings.local.json           (per-machine overrides: provider/model; gitignored)
# Later sources win per-key, so base/local override stale runtime values while
# runtime-only keys (not present in base/local) are preserved across regens.
#
# Usage: gen-pi-settings.sh [--quiet]
set -euo pipefail

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1
log() { [[ "$QUIET" == 1 ]] || printf '%s\n' "$*"; }

# Resolve repo root from this script's location (scripts/ is at repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BASE="$REPO_ROOT/pi/.pi/agent/settings.base.json"
LOCAL="$HOME/.pi/agent/settings.local.json"
DEST="$HOME/.pi/agent/settings.json"

[[ -f "$BASE" ]] || { log "No settings.base.json at $BASE; skipping."; exit 0; }

if ! command -v jq >/dev/null 2>&1; then
  # No jq: fall back to a plain copy so the theme/packages at least load.
  log "jq not found; copying base settings only (install jq for local merging)."
  [[ -L "$DEST" ]] && rm "$DEST"
  mkdir -p "$(dirname "$DEST")"
  cp "$BASE" "$DEST"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"
# Drop a stale stow symlink so we write a real, locally-mutable file.
[[ -L "$DEST" ]] && rm "$DEST"

# Sources in increasing precedence. Use {} for any that are missing.
existing="$DEST";        [[ -f "$existing" ]] || existing=/dev/null
local_overrides="$LOCAL"; [[ -f "$local_overrides" ]] || local_overrides=/dev/null

tmp="$(mktemp)"
jq -s '
  (.[0] // {}) * (.[1] // {}) * (.[2] // {})
' \
  <(cat "$existing" 2>/dev/null || echo '{}') \
  "$BASE" \
  <(cat "$local_overrides" 2>/dev/null || echo '{}') \
  > "$tmp"
mv "$tmp" "$DEST"

if [[ "$local_overrides" == /dev/null ]]; then
  log "Generated $DEST from settings.base.json (no settings.local.json found)."
  log "Copy pi/.pi/agent/settings.local.json.example → $LOCAL for per-machine overrides."
else
  log "Generated $DEST (base + local merged, runtime keys preserved)."
fi
