#!/usr/bin/env bash
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
quoted_script_path="$(printf '%q' "$script_path")"

list_sessions() {
  local mode="${1:-all}"
  local args=(--json)

  case "$mode" in
    all)
      args+=(--hide-duplicates)
      ;;
    tmux)
      args+=(--tmux)
      ;;
    zoxide)
      args+=(--zoxide)
      ;;
    *)
      printf 'Unknown session list mode: %s\n' "$mode" >&2
      return 2
      ;;
  esac

  sesh list "${args[@]}" | python3 -c '
import json
import sys

icons = {
    "tmux": "",
    "zoxide": "",
    "config": "⚙",
    "tmuxinator": "⚙",
}

for session in json.load(sys.stdin):
    src = session.get("Src", "")
    name = session.get("Name") or session.get("Path") or ""
    if src in {"tmux", "config", "tmuxinator"}:
        target = session.get("Name") or name
    else:
        target = session.get("Path") or name
    print(f"{icons.get(src, "•")} {name}\t{target}\t{src}")
'
}

kill_if_tmux_session() {
  local selection="$1"
  local target src
  IFS=$'\t' read -r _ target src <<<"$selection"

  if [[ "$src" == "tmux" && -n "$target" ]]; then
    tmux kill-session -t "$target" 2>/dev/null || true
  fi
}

case "${1:-}" in
  --list)
    list_sessions "${2:-all}"
    exit 0
    ;;
  --kill)
    kill_if_tmux_session "${2:-}"
    exit 0
    ;;
esac

selection="$(list_sessions all | fzf \
  --no-tmux \
  --delimiter=$'\t' \
  --with-nth=1 \
  --height=100% \
  --border-label=' Sessions ' \
  --prompt='> ' \
  --header='enter: connect · ctrl-a: all · ctrl-t: tmux · ctrl-z: zoxide · ctrl-d: kill tmux session' \
  --reverse \
  --algo=v1 \
  --tiebreak=begin,length \
  --bind='tab:down,btab:up' \
  --bind="ctrl-a:change-prompt(> )+reload($quoted_script_path --list all)" \
  --bind="ctrl-t:change-prompt( )+reload($quoted_script_path --list tmux)" \
  --bind="ctrl-z:change-prompt( )+reload($quoted_script_path --list zoxide)" \
  --bind="ctrl-d:execute-silent($quoted_script_path --kill {})+reload($quoted_script_path --list all)" \
  --preview-window=hidden \
  --info=inline \
  --padding=1)" || exit 0

[[ -n "$selection" ]] || exit 0

IFS=$'\t' read -r _ target _ <<<"$selection"
[[ -n "$target" ]] || exit 0

exec sesh connect --switch "$target"
