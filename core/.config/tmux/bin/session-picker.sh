#!/usr/bin/env bash

selection="$(sesh list --icons --no-color | fzf \
  --border-label=' Sessions ' \
  --prompt='> ' \
  --header='' \
  --reverse \
  --algo=v1 \
  --tiebreak=begin,length \
  --bind='tab:down,btab:up' \
  --bind='ctrl-x:change-prompt(📁 )+reload(sesh list -z --icons --no-color)' \
  --bind='ctrl-d:execute-silent(tmux kill-session -t {2..})+reload(sesh list --icons --no-color)' \
  --preview-window=hidden \
  --info=inline \
  --padding=1)" || exit 0

[ -n "$selection" ] || exit 0

target="${selection#* }"
[ -n "$target" ] || exit 0

exec sesh connect --switch "$target"
