#!/bin/sh
# Join the focused pane into the NEXT tab of its workspace as a split
# (tmux join-pane -t :+ analogue). Wraps to the first tab when the current
# tab is last; a single-tab workspace is a no-op reposition. If the pane was
# alone in its tab, herdr removes the now-empty source tab.
set -eu

herdr="${HERDR_BIN_PATH:-herdr}"
pane="${HERDR_ACTIVE_PANE_ID:?no active pane}"
tab="${HERDR_ACTIVE_TAB_ID:?no active tab}"
ws="${HERDR_ACTIVE_WORKSPACE_ID:?no active workspace}"

next_tab="$("$herdr" tab list | jq -r \
    --arg ws "$ws" --arg tab "$tab" '
    [.result.tabs[] | select(.workspace_id == $ws)] as $t
    | ($t | map(.tab_id) | index($tab)) as $i
    | if ($t | length) < 2 or $i == null then ""
      else $t[($i + 1) % ($t | length)].tab_id end')"

# Nothing to join with.
[ -n "$next_tab" ] || exit 0

# Moving out of a zoomed tab is refused (reason: zoomed_tab); un-zoom first.
"$herdr" pane zoom "$pane" --off >/dev/null 2>&1 || true
"$herdr" pane move "$pane" --tab "$next_tab" --split right --focus >/dev/null
