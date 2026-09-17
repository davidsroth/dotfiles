#!/usr/bin/env bash
# Verify that tracked Pi extension modules are present through the stowed runtime.
# This is deliberately read-only: it diagnoses drift but never runs stow.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_PREFIX="pi/.pi/agent/extensions"
RUNTIME_ROOT="${PI_EXTENSIONS_RUNTIME_DIR:-$HOME/.pi/agent/extensions}"

if [[ ! -e "$RUNTIME_ROOT" ]]; then
  echo "pi-runtime-links: $RUNTIME_ROOT is not deployed; skipping runtime-link check."
  exit 0
fi
if [[ ! -d "$RUNTIME_ROOT" ]]; then
  echo "pi-runtime-links: runtime path is not a directory: $RUNTIME_ROOT" >&2
  exit 1
fi

module_count=0
failures=0
while IFS= read -r -d '' tracked; do
  case "$tracked" in
    *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs) ;;
    *) continue ;;
  esac

  relative="${tracked#${SOURCE_PREFIX}/}"
  runtime_path="$RUNTIME_ROOT/$relative"
  module_count=$((module_count + 1))

  if [[ ! -e "$runtime_path" ]]; then
    echo "pi-runtime-links: missing tracked module: $runtime_path" >&2
    failures=$((failures + 1))
    continue
  fi

  # Support both leaf links (stow into an existing directory) and folded
  # directory links. Only count links at or below RUNTIME_ROOT: an unrelated
  # symlink in an ancestor such as macOS's /tmp -> /private/tmp is not a deploy.
  linked=false
  candidate="$RUNTIME_ROOT"
  [[ -L "$candidate" ]] && linked=true
  IFS='/' read -r -a path_parts <<< "$relative"
  for part in "${path_parts[@]}"; do
    candidate="$candidate/$part"
    if [[ -L "$candidate" ]]; then
      linked=true
      break
    fi
  done
  if [[ "$linked" != true ]]; then
    echo "pi-runtime-links: tracked module is present but not linked: $runtime_path" >&2
    failures=$((failures + 1))
  fi
done < <(git -C "$REPO_ROOT" ls-files -z -- "$SOURCE_PREFIX")

if (( failures > 0 )); then
  echo "pi-runtime-links: $failures of $module_count tracked extension module(s) are not deployed as links." >&2
  echo "pi-runtime-links: run 'just stow' from the canonical dotfiles checkout, then retry." >&2
  exit 1
fi

echo "pi-runtime-links: OK — $module_count tracked extension module(s) are linked in $RUNTIME_ROOT."
