#!/usr/bin/env bash
set -euo pipefail

# Herdr workspace picker — the flow Herdr has no built-in for: opening a
# directory that is not a workspace yet. Herdr's own new_workspace always
# starts at $HOME with no prompt, and its goto/navigate overlays only reach
# what is already open.
#
# Rows are open Herdr workspaces first, then zoxide directories. Enter focuses
# an open workspace, or creates one rooted at the chosen directory. A typed
# query that matches no row is resolved through zoxide, so "dotfi" opens
# ~/dotfiles the same way `z dotfi` would.
#
# The tmux equivalent lives in ~/.config/tmux/bin/session-picker.sh; this one
# talks to the Herdr socket API instead of sesh.

# Rows: display <TAB> target <TAB> kind
list_rows() {
	python3 -c '
import json, os, subprocess

home = os.path.expanduser("~")


def tilde(path):
    if path == home:
        return "~"
    if path.startswith(home + os.sep):
        return "~" + path[len(home):]
    return path


def snapshot():
    out = subprocess.run(["herdr", "api", "snapshot"], capture_output=True, text=True).stdout
    try:
        return json.loads(out)["result"]["snapshot"]
    except Exception:
        return {}


snap = snapshot()

# A workspace has no cwd of its own; take it from its first pane.
ws_cwd = {}
for pane in snap.get("panes", []):
    ws_cwd.setdefault(pane.get("workspace_id"), pane.get("cwd") or "")

STATUS = {"working": "\033[33m●\033[0m", "blocked": "\033[31m●\033[0m",
          "done": "\033[32m●\033[0m", "idle": "\033[90m●\033[0m"}

rows = []
open_paths = set()
for ws in snap.get("workspaces", []):
    wid = ws.get("workspace_id", "")
    cwd = ws_cwd.get(wid, "")
    if cwd:
        open_paths.add(os.path.realpath(cwd))
    dot = STATUS.get(ws.get("agent_status") or "", "\033[90m○\033[0m")
    label = ws.get("label") or wid
    rows.append(("%s %-28s \033[90m%s\033[0m" % (dot, label, tilde(cwd)), wid, "workspace"))

# zoxide directories that are not already open
try:
    zox = subprocess.run(["zoxide", "query", "-l"], capture_output=True, text=True).stdout
except FileNotFoundError:
    zox = ""
for line in zox.splitlines():
    path = line.strip()
    if not path or not os.path.isdir(path):
        continue
    if os.path.realpath(path) in open_paths:
        continue
    rows.append(("  %-28s \033[90m%s\033[0m" % (os.path.basename(path) or path, tilde(path)),
                 path, "dir"))

for display, target, kind in rows:
    print("%s\t%s\t%s" % (display, target, kind))
'
}

# Focus the workspace already rooted at $1, if there is one.
workspace_at() {
	python3 -c '
import json, os, subprocess, sys

want = os.path.realpath(os.path.expanduser(sys.argv[1]))
out = subprocess.run(["herdr", "api", "snapshot"], capture_output=True, text=True).stdout
try:
    snap = json.loads(out)["result"]["snapshot"]
except Exception:
    sys.exit(0)
seen = {}
for pane in snap.get("panes", []):
    seen.setdefault(pane.get("workspace_id"), pane.get("cwd") or "")
for wid, cwd in seen.items():
    if cwd and os.path.realpath(cwd) == want:
        print(wid)
        break
' "$1"
}

open_dir() {
	local dir="$1" existing
	existing="$(workspace_at "$dir")"
	if [[ -n "$existing" ]]; then
		herdr workspace focus "$existing" >/dev/null
	else
		herdr workspace create --cwd "$dir" --label "$(basename "$dir")" --focus >/dev/null
	fi
}

# Resolve a query that matched no row: a real path, else zoxide's best guess.
resolve_query() {
	local query="${1/#\~/$HOME}"
	[[ -n "$query" ]] || return 1
	if [[ -d "$query" ]]; then
		printf '%s\n' "$(cd "$query" && pwd)"
		return 0
	fi
	zoxide query -- "$query" 2>/dev/null
}

main() {
	local out query selection target kind
	# fzf exits 1 when the query matches no row, which is the case this picker
	# cares most about: a directory that has no workspace yet. Keep that exit
	# status from tripping `set -e`.
	set +o pipefail +e
	out="$(list_rows | fzf \
		--print-query \
		--delimiter=$'\t' \
		--with-nth=1 \
		--height=100% \
		--border-label=' Workspaces ' \
		--prompt='> ' \
		--header='enter: open · unmatched text resolves through zoxide' \
		--reverse \
		--ansi \
		--algo=v1 \
		--tiebreak=begin,length \
		--bind='tab:down,btab:up' \
		--info=inline \
		--padding=1)"
	set -o pipefail -e

	query="$(printf '%s\n' "$out" | sed -n '1p')"
	selection="$(printf '%s\n' "$out" | sed -n '2p')"

	if [[ -n "$selection" ]]; then
		IFS=$'\t' read -r _ target kind <<<"$selection"
		case "$kind" in
			workspace) herdr workspace focus "$target" >/dev/null ;;
			dir) open_dir "$target" ;;
		esac
		return 0
	fi

	# Nothing matched: treat the query as a directory to open.
	local dir
	dir="$(resolve_query "$query" || true)"
	if [[ -n "$dir" && -d "$dir" ]]; then
		open_dir "$dir"
	fi
}

main "$@"
