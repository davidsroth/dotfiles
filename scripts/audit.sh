#!/usr/bin/env bash
# Deterministic, offline validation of tracked repository configuration.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

command -v git >/dev/null 2>&1 || { echo "ERR git is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERR python3 is required" >&2; exit 1; }

failures=0
checked=0

failure() {
  printf 'ERR %s\n' "$*" >&2
  failures=$((failures + 1))
}

skip_path() {
  case "$1" in
    node_modules/*|*/node_modules/*) return 0 ;;
    *) return 1 ;;
  esac
}

require_tracked_path() {
  local file="$1"
  if [[ ! -e "$file" && ! -L "$file" ]]; then
    failure "tracked path missing from working tree: $file"
    return 1
  fi
}

printf '%s\n' 'Tracked path presence'
while IFS= read -r -d '' file; do
  skip_path "$file" && continue
  require_tracked_path "$file" || true
done < <(git ls-files -z)

printf '%s\n' 'Shell syntax (tracked files)'
while IFS= read -r -d '' file; do
  skip_path "$file" && continue
  [[ -e "$file" || -L "$file" ]] || continue
  LC_ALL=C grep -Iq . "$file" || continue
  first_line="$(head -n 1 "$file" 2>/dev/null || true)"
  shell=""
  case "$file:$first_line" in
    zsh/*:*|core/.config/shell/aliases.sh:*|core/.config/shell/functions.sh:*|*:*zsh*) shell=zsh ;;
    *.sh:*|*:*bash*) shell=bash ;;
    *:'#!'/bin/sh|*:'#!'/usr/bin/sh) shell="sh" ;;
  esac
  [[ -n "$shell" ]] || continue
  if ! command -v "$shell" >/dev/null 2>&1; then
    printf 'SKIP %-4s %s (interpreter not installed)\n' "$shell" "$file"
    continue
  fi
  checked=$((checked + 1))
  "$shell" -n "$file" || failure "$shell syntax: $file"
done < <(git ls-files -z)

if command -v shellcheck >/dev/null 2>&1; then
  printf '%s\n' 'ShellCheck (tracked Bash files)'
  bash_files=()
  while IFS= read -r -d '' file; do
    skip_path "$file" && continue
    [[ -f "$file" ]] || continue
    LC_ALL=C grep -Iq . "$file" || continue
    first_line="$(head -n 1 "$file" 2>/dev/null || true)"
    [[ "$first_line" == *bash* ]] && bash_files+=("$file")
  done < <(git ls-files -z)
  if (( ${#bash_files[@]} > 0 )); then
    checked=$((checked + ${#bash_files[@]}))
    # ShellCheck versions disagree on whether informational findings affect
    # the exit status, so make the enforced threshold explicit.
    shellcheck -x --severity=warning "${bash_files[@]}" || failure "ShellCheck"
  fi
else
  printf '%s\n' 'SKIP ShellCheck (shellcheck not installed)'
fi

printf '%s\n' 'JSON syntax (tracked files)'
while IFS= read -r -d '' file; do
  skip_path "$file" && continue
  [[ -e "$file" || -L "$file" ]] || continue
  checked=$((checked + 1))
  python3 -m json.tool "$file" >/dev/null || failure "JSON syntax: $file"
done < <(git ls-files -z -- '*.json')

if command -v luac >/dev/null 2>&1; then
  printf '%s\n' 'Lua syntax (tracked files)'
  while IFS= read -r -d '' file; do
    skip_path "$file" && continue
    [[ -e "$file" || -L "$file" ]] || continue
    checked=$((checked + 1))
    luac -p "$file" || failure "Lua syntax: $file"
  done < <(git ls-files -z -- '*.lua')
else
  printf '%s\n' 'SKIP Lua syntax (luac not installed)'
fi

if python3 -c 'import tomllib' >/dev/null 2>&1; then
  printf '%s\n' 'TOML syntax (tracked files)'
  while IFS= read -r -d '' file; do
    skip_path "$file" && continue
    [[ -e "$file" || -L "$file" ]] || continue
    checked=$((checked + 1))
    python3 - "$file" >/dev/null <<'PY' || failure "TOML syntax: $file"
import sys
import tomllib

with open(sys.argv[1], "rb") as handle:
    tomllib.load(handle)
PY
  done < <(git ls-files -z -- '*.toml')
else
  printf '%s\n' 'SKIP TOML syntax (Python tomllib not available)'
fi

if command -v ruby >/dev/null 2>&1; then
  printf '%s\n' 'YAML syntax (tracked files)'
  while IFS= read -r -d '' file; do
    skip_path "$file" && continue
    [[ -e "$file" || -L "$file" ]] || continue
    checked=$((checked + 1))
    ruby -e 'require "yaml"; YAML.parse_file(ARGV.fetch(0))' "$file" || failure "YAML syntax: $file"
  done < <(git ls-files -z -- '*.yaml' '*.yml')
else
  printf '%s\n' 'SKIP YAML syntax (ruby not installed)'
fi

printf '%s\n' 'Tracked symlinks'
while IFS= read -r -d '' file; do
  skip_path "$file" && continue
  [[ -e "$file" || -L "$file" ]] || continue
  if [[ -L "$file" && ! -e "$file" ]]; then
    failure "broken symlink: $file -> $(readlink "$file")"
  fi
done < <(git ls-files -z)

if (( failures > 0 )); then
  printf 'Audit failed: %d error(s) across %d checks.\n' "$failures" "$checked" >&2
  exit 1
fi
printf 'Audit passed: %d tracked-file checks.\n' "$checked"
