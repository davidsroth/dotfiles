#!/usr/bin/env bash
#
# pi-typecheck.sh — typecheck the hand-written pi extensions in
# pi/.pi/agent/extensions against the EXACT pi SDK that is currently installed.
#
# pi loads extensions via jiti, aliasing the @earendil-works/* (and typebox)
# specifiers to its own bundled copies — so a local node_modules NEVER shadows
# the SDK at runtime. We exploit that here: we build a gitignored symlink farm
# under extensions/node_modules pointing at the running pi install, then run
# `tsc --noEmit`. This pins the typecheck to the version pi actually runs (no
# drift, no npm download of the SDK) and is purely a build-time concern.
#
# Usage: scripts/pi-typecheck.sh   (or: just pi-check)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$REPO/pi/.pi/agent/extensions"
TS_VERSION="5.7"

if [[ ! -d "$EXT" ]]; then
  echo "pi-check: extensions dir not found at $EXT" >&2
  exit 1
fi

# --- Resolve the installed pi SDK package directory -------------------------
resolve_pi_pkg() {
  local cli
  if command -v pi >/dev/null 2>&1; then
    cli="$(command -v pi)"
    # Follow symlinks to the real cli.js, then strip /dist/...
    cli="$(realpath "$cli" 2>/dev/null || readlink -f "$cli" 2>/dev/null || echo "$cli")"
    local pkg="${cli%/dist/*}"
    if [[ -f "$pkg/package.json" ]]; then
      echo "$pkg"
      return 0
    fi
  fi
  # Fallback: npm global root
  local groot
  groot="$(npm root -g 2>/dev/null || true)"
  if [[ -n "$groot" && -d "$groot/@earendil-works/pi-coding-agent" ]]; then
    echo "$groot/@earendil-works/pi-coding-agent"
    return 0
  fi
  return 1
}

if ! PI_PKG="$(resolve_pi_pkg)"; then
  echo "pi-check: could not locate the installed @earendil-works/pi-coding-agent." >&2
  echo "          Install pi (so it is on PATH) and retry." >&2
  exit 1
fi
echo "pi-check: SDK -> $PI_PKG"

# --- Build the gitignored symlink farm --------------------------------------
NM="$EXT/node_modules"
SCOPE="$NM/@earendil-works"
rm -rf "$NM"
mkdir -p "$SCOPE"

link() { # link <target> <linkpath>
  if [[ -e "$1" ]]; then
    ln -sfn "$1" "$2"
  else
    echo "pi-check: warning: missing SDK dep $1 (skipping)" >&2
  fi
}

link "$PI_PKG"                                              "$SCOPE/pi-coding-agent"
link "$PI_PKG/node_modules/@earendil-works/pi-tui"         "$SCOPE/pi-tui"
link "$PI_PKG/node_modules/@earendil-works/pi-ai"          "$SCOPE/pi-ai"
link "$PI_PKG/node_modules/@earendil-works/pi-agent-core"  "$SCOPE/pi-agent-core"
link "$PI_PKG/node_modules/typebox"                        "$NM/typebox"

# --- Typecheck --------------------------------------------------------------
echo "pi-check: running tsc --noEmit (typescript@$TS_VERSION) ..."
cd "$EXT"
npx -y -p "typescript@$TS_VERSION" tsc --noEmit -p tsconfig.json
echo "pi-check: OK — extensions typecheck clean."
