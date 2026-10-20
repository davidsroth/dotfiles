#!/usr/bin/env bash
# Refuse setup before it can link plugins unsupported by the installed Herdr.
set -euo pipefail

readonly MIN_HERDR_VERSION="0.9.2"
readonly MIN_MAJOR=0 MIN_MINOR=9 MIN_PATCH=2
herdr_bin="${HERDR_BIN_PATH:-herdr}"

if ! command -v "$herdr_bin" >/dev/null 2>&1; then
  echo "herdr: not found" >&2
  exit 1
fi

if ! version_output="$("$herdr_bin" --version 2>&1)"; then
  echo "herdr: could not determine version" >&2
  exit 1
fi

if [[ ! "$version_output" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  echo "herdr: could not parse version from: ${version_output%%$'\n'*}" >&2
  exit 1
fi

found=$((10#${BASH_REMATCH[1]} * 1000000 + 10#${BASH_REMATCH[2]} * 1000 + 10#${BASH_REMATCH[3]}))
required=$((MIN_MAJOR * 1000000 + MIN_MINOR * 1000 + MIN_PATCH))
if ((found < required)); then
  echo "herdr: $MIN_HERDR_VERSION or newer is required (found ${BASH_REMATCH[0]})" >&2
  echo "Upgrade Herdr before running 'just herdr-setup'; no plugins were linked." >&2
  exit 1
fi
