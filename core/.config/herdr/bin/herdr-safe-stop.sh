#!/bin/sh
set -eu

if [ "${HERDR_ENV:-}" = "1" ] || [ -n "${HERDR_PANE_ID:-}${HERDR_TAB_ID:-}${HERDR_WORKSPACE_ID:-}" ]; then
  echo "herdr-safe-stop: run this from a regular terminal outside Herdr" >&2
  exit 1
fi

config_root="${XDG_CONFIG_HOME:-$HOME/.config}"
guard="$config_root/herdr/plugins/session-guard/session_guard.py"

if [ ! -f "$guard" ]; then
  echo "herdr-safe-stop: session guard is not installed at $guard" >&2
  echo "Run 'just stow-restow herdr-setup' from the dotfiles checkout." >&2
  exit 1
fi

exec python3 "$guard" safe-stop "$@"
