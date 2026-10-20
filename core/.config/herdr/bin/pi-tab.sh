#!/bin/sh
# Open a new tab in the active workspace, in the focused pane's directory, and
# start pi in it. Herdr custom commands have no "tab" type, so this goes through
# the CLI: create the tab, then type `pi` into its root pane's shell.
set -eu

herdr="${HERDR_BIN_PATH:-herdr}"
ws="${HERDR_ACTIVE_WORKSPACE_ID:?no active workspace}"

cwd=""
if [ -n "${HERDR_ACTIVE_PANE_ID:-}" ]; then
    cwd="$("$herdr" pane get "$HERDR_ACTIVE_PANE_ID" |
        jq -r '.result.pane.foreground_cwd // .result.pane.cwd // empty')"
fi
[ -d "$cwd" ] || cwd="$PWD"

pane="$("$herdr" tab create --workspace "$ws" --cwd "$cwd" --focus |
    jq -r '.result.root_pane.pane_id')"
"$herdr" pane run "$pane" pi >/dev/null
