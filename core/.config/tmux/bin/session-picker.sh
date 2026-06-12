#!/usr/bin/env bash
set -euo pipefail

# Thin launcher for the tmux session picker. All row production (sesh
# sessions, zoxide dirs, cached git worktrees, pi markers, dedup) lives in
# session-picker.py — including the row-format contract that fzf ranking
# depends on. This script owns the process concerns: the fzf invocation,
# tmux popup lifecycle, and the connect/kill actions.

script_path="${BASH_SOURCE[0]}"
quoted_script_path="$(printf '%q' "$script_path")"
picker_py="$(cd "$(dirname "$script_path")" && pwd)/session-picker.py"

selection_target() {
  local selection="$1"
  local _display target _src
  IFS=$'\t' read -r _display target _src <<<"$selection"
  printf '%s\n' "$target"
}

connect_selection() {
  local target
  target="$(selection_target "$1")"
  [[ -n "$target" ]] || exit 0

  # If fzf `become`s this command while the list producer is still hydrating,
  # do not keep the producer pipe open. Closing stdin lets the producer take
  # SIGPIPE immediately instead of delaying the tmux switch.
  exec </dev/null

  # `become` switches quickly, but the parent popup shell can stay alive until
  # the still-hydrating producer exits. Close the popup explicitly after the
  # switch so the overlay disappears immediately.
  sesh connect --switch "$target"
  local status=$?
  if [[ -n "${TMUX:-}" ]]; then
    tmux display-popup -C 2>/dev/null || true
  fi
  exit "$status"
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
    exec python3 "$picker_py" list "${2:-all}"
    ;;
  --status)
    exec python3 "$picker_py" status
    ;;
  --kill)
    kill_if_tmux_session "${2:-}"
    exit 0
    ;;
  --connect)
    connect_selection "${2:-}"
    ;;
esac

# Let fzf directly `become` the connect command. Capturing fzf output in a
# command substitution makes Bash wait for the still-hydrating producer before
# it can run `sesh connect`, which feels like a long delay after pressing enter.
set +o pipefail
python3 "$picker_py" list all | fzf \
  --no-tmux \
  --delimiter=$'\t' \
  --with-nth=1 \
  --height=100% \
  --border-label=' Sessions ' \
  --prompt='> ' \
  --header='enter: connect · ctrl-a/t/z/w filters · ctrl-d: kill tmux session' \
  --reverse \
  --ansi \
  --algo=v1 \
  --tiebreak=begin,length \
  --bind='tab:down,btab:up' \
  --bind="enter:become($quoted_script_path --connect {})" \
  --bind="ctrl-a:change-prompt(> )+reload($quoted_script_path --list all)" \
  --bind="ctrl-t:change-prompt( )+reload($quoted_script_path --list tmux)" \
  --bind="ctrl-z:change-prompt( )+reload($quoted_script_path --list zoxide)" \
  --bind="ctrl-w:change-prompt( )+reload($quoted_script_path --list worktree)" \
  --bind="ctrl-d:execute-silent($quoted_script_path --kill {})+reload($quoted_script_path --list all)" \
  --preview-window=hidden \
  --info=inline \
  --padding=1 || exit 0
