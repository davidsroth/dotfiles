#!/usr/bin/env bash
set -euo pipefail

# Ensure tmux is available
if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH" >&2
  exit 1
fi

# Choose editor: prefer $EDITOR over $VISUAL
EDITOR_CMD="${EDITOR:-${VISUAL:-nvim}}"

# If inside a git repo, move to repo root; else stay in cwd
in_git=0
git_root=""
if git_root=$(git rev-parse --show-toplevel 2>/dev/null); then
  in_git=1
  cd "$git_root"
fi

# Collect recent files into a temp file (newline-delimited paths)
tmp_list=$(mktemp)
trap 'rm -f "$tmp_list"' EXIT

add_existing_unique() {
  # Reads newline-delimited paths on stdin; outputs unique existing files
  awk 'NF' | awk '!seen[$0]++' | while IFS= read -r f; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
  return 0
}

if [ "$in_git" -eq 1 ]; then
  # Uncommitted changes: untracked + unstaged + staged (NUL-safe -> newline)
  {
    git ls-files -o --exclude-standard -z 2>/dev/null || true
    git diff --name-only -z 2>/dev/null || true
    git diff --name-only --cached -z 2>/dev/null || true
  } | tr '\0' '\n' | add_existing_unique > "$tmp_list"

  # Recently committed files (limit, NUL-safe). We use --name-only and
  # then keep only existing paths to drop deletes/renames to non-existing.
  recent_tmp=$(mktemp)
  trap 'rm -f "$tmp_list" "$recent_tmp"' EXIT
  git log --no-merges --name-only -z -n 1000 -- . 2>/dev/null \
    | tr '\0' '\n' \
    | add_existing_unique \
    | head -n 500 > "$recent_tmp" || true

  # Merge and dedup
  { cat "$tmp_list"; cat "$recent_tmp"; } | add_existing_unique > "$tmp_list.merged"
  mv "$tmp_list.merged" "$tmp_list"
  rm -f "$recent_tmp"
else
  # Non-git fallback: sort files by mtime and take the top N
  limit=500
  if command -v fd >/dev/null 2>&1; then
    fd -t f -H -E .git -0 . \
      | xargs -0 -n1 stat -f '%m %N' \
      | sort -nr \
      | awk '{ $1=""; sub(/^ /,""); print }' \
      | head -n "$limit" \
      | add_existing_unique > "$tmp_list"
  elif command -v rg >/dev/null 2>&1; then
    rg --files -0 -g '!**/.git/**' \
      | xargs -0 -n1 stat -f '%m %N' \
      | sort -nr \
      | awk '{ $1=""; sub(/^ /,""); print }' \
      | head -n "$limit" \
      | add_existing_unique > "$tmp_list"
  else
    # Portable but slower: find + stat loop
    # macOS find lacks -printf, so we stat each file
    while IFS= read -r -d '' f; do
      # Print epoch and name; then sort later
      stat -f '%m %N' "$f"
    done < <(find . -type f -not -path '*/.git/*' -print0)
    sort -nr \
      | awk '{ $1=""; sub(/^ /,""); print }' \
      | head -n "$limit" \
      | add_existing_unique > "$tmp_list"
  fi
fi

# If no results, exit quietly
if ! [ -s "$tmp_list" ]; then
  exit 0
fi

# Picker command (use fzf-tmux only inside tmux)
picker_cmd=()
if [ -n "${TMUX:-}" ] && command -v fzf-tmux >/dev/null 2>&1; then
  picker_cmd=(fzf-tmux -p 80%,80%)
elif command -v fzf >/dev/null 2>&1; then
  picker_cmd=(fzf)
fi

# Select files
selected=""
if [ ${#picker_cmd[@]} -gt 0 ]; then
  if command -v bat >/dev/null 2>&1; then
    preview='bat --style=numbers --color=always --line-range=:200 {}'
  else
    # Use non-aliased sed to avoid environments where sed is aliased to sd
    preview='command sed -n "1,200p" {}'
  fi
  selected=$("${picker_cmd[@]}" \
    --multi \
    --prompt="Recent files > " \
    --height=90% \
    --reverse \
    --preview-window=right:60% \
    --preview="$preview" < "$tmp_list") || selected=""
else
  selected=$(head -n 1 "$tmp_list" 2>/dev/null || true)
fi

# Nothing picked
[ -z "${selected:-}" ] && exit 0

# Build the editor command with proper quoting
cmd_q="$EDITOR_CMD"
while IFS= read -r f; do
  [ -z "$f" ] && continue
  printf -v esc '%q' "$f"
  cmd_q+=" $esc"
done <<< "$selected"

# Open in tmux (new window if inside tmux, else new session)
if [ -n "${TMUX:-}" ]; then
  tmux new-window -n 'recent' "$cmd_q" || true
else
  tmux new-session -n 'recent' "$cmd_q" || true
fi

exit 0
