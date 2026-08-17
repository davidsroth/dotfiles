#!/bin/sh
# Break the focused pane out of its tab into a new tab of the same workspace
# (tmux break-pane analogue). If the pane was alone in its tab this is
# effectively a no-op (herdr removes the empty source tab and adds the new one).
set -eu

herdr="${HERDR_BIN_PATH:-herdr}"
pane="${HERDR_ACTIVE_PANE_ID:?no active pane}"

# Moving out of a zoomed tab is refused (reason: zoomed_tab); un-zoom first.
"$herdr" pane zoom "$pane" --off >/dev/null 2>&1 || true
"$herdr" pane move "$pane" --new-tab --focus >/dev/null
