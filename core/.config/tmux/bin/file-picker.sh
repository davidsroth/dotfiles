#!/usr/bin/env bash
# Pick a repository file safely and open it in a new tmux window.
set -euo pipefail

root="${1:-$PWD}"
cd -- "$root"

for command in fd fzf tmux; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'file-picker: required command not found: %s\n' "$command" >&2
    exit 1
  fi
done

selected=""
IFS= read -r -d '' selected < <(
  fd --type f --hidden --exclude .git --strip-cwd-prefix --print0 . |
    fzf --read0 --print0 --tmux 80%,80% \
      --prompt='Find file> ' --layout=reverse --border=none \
      --preview 'bat --style=numbers --color=always -- {}' \
      --preview-window=right:60%
) || [[ -n "$selected" ]] || exit 0

editor="${VISUAL:-${EDITOR:-nvim}}"
if ! command -v "$editor" >/dev/null 2>&1; then
  printf 'file-picker: editor not found: %s\n' "$editor" >&2
  exit 1
fi

tmux new-window -c "$root" -- "$editor" "$selected"
