#!/usr/bin/env bash
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
quoted_script_path="$(printf '%q' "$script_path")"
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/tmux-session-picker"
worktree_cache="$cache_dir/worktrees.tsv"
worktree_lock_dir="$cache_dir/worktrees.lock"
worktree_cache_ttl=60
pi_cache="$cache_dir/pi-sessions.tsv"
pi_lock_dir="$cache_dir/pi-sessions.lock"
pi_cache_ttl=2

cache_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || printf '0'
}

cache_file_fresh() {
  local file="$1" ttl="$2" now mtime
  [[ -f "$file" ]] || return 1
  now="$(date +%s)"
  mtime="$(cache_mtime "$file")"
  [[ "$mtime" =~ ^[0-9]+$ ]] || return 1
  (( now - mtime < ttl ))
}

acquire_cache_lock() {
  local lock_dir="$1" stale_after="${2:-300}" now mtime
  mkdir "$lock_dir" 2>/dev/null && return 0
  [[ -d "$lock_dir" ]] || return 1

  now="$(date +%s)"
  mtime="$(cache_mtime "$lock_dir")"
  [[ "$mtime" =~ ^[0-9]+$ ]] || return 1
  if (( now - mtime > stale_after )); then
    rmdir "$lock_dir" 2>/dev/null || return 1
    mkdir "$lock_dir" 2>/dev/null && return 0
  fi
  return 1
}

current_tmux_session() {
  [[ -n "${TMUX:-}" ]] || return 0
  tmux display-message -p '#S' 2>/dev/null || true
}

active_pi_sessions_raw() {
  command -v tmux >/dev/null 2>&1 || return 0

  python3 -c '
import os
import re
import signal
import subprocess

signal.signal(signal.SIGPIPE, signal.SIG_DFL)

try:
    panes = subprocess.check_output(
        ["tmux", "list-panes", "-a", "-F", "#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_current_path}"],
        stderr=subprocess.DEVNULL,
        text=True,
    ).splitlines()
except Exception:
    panes = []

try:
    ps_lines = subprocess.check_output(
        ["ps", "-ax", "-o", "pid=,ppid=,comm="],
        stderr=subprocess.DEVNULL,
        text=True,
    ).splitlines()
except Exception:
    ps_lines = []

children = {}
for line in ps_lines:
    parts = line.split(None, 2)
    if len(parts) < 3:
        continue
    pid, ppid, comm = parts
    children.setdefault(ppid, []).append(os.path.basename(comm))

input_re = re.compile(r"Question \d+ of \d+|Your answer|Ctrl\+Enter submit all")
working_re = re.compile(r"Working\.\.\.|Thinking\.\.\.|Generating\.\.\.|Running tool|\d+ running agent")

for line in panes:
    try:
        target, pane_pid, cwd = line.split("\t", 2)
    except ValueError:
        continue
    if "pi" not in children.get(pane_pid, []):
        continue

    try:
        pane_text = subprocess.check_output(
            ["tmux", "capture-pane", "-p", "-S", "-12", "-t", target],
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except Exception:
        pane_text = ""

    status = "idle"
    # The pi TUI can leave a spinner visible while a Q&A card is waiting for
    # input, so treat explicit input cards as idle before looking for activity
    # strings. This is still heuristic until pi exposes a status heartbeat.
    if not input_re.search(pane_text) and working_re.search(pane_text):
        status = "working"

    print(f"{cwd}\t{status}")
'
}

refresh_pi_cache() {
  mkdir -p "$cache_dir"
  if ! acquire_cache_lock "$pi_lock_dir" 10; then
    return 0
  fi

  local tmp status=0
  tmp="$(mktemp "$cache_dir/pi-sessions.XXXXXX")"
  active_pi_sessions_raw | python3 -c '
import os
import signal
import sys

signal.signal(signal.SIGPIPE, signal.SIG_DFL)


def git_root(path):
    cur = os.path.realpath(path)
    while cur and cur != os.path.dirname(cur):
        if os.path.exists(os.path.join(cur, ".git")):
            return cur
        cur = os.path.dirname(cur)
    return os.path.realpath(path)


sessions = {}
for line in sys.stdin:
    cwd, sep, status = line.rstrip("\n").partition("\t")
    if not cwd or not sep:
        continue
    root = git_root(cwd)
    # If multiple pi sessions share a root, working wins over idle.
    if sessions.get(root) != "working":
        sessions[root] = status or "idle"

for root, status in sessions.items():
    print(f"{root}\t{status}")
' >"$tmp" || status=$?
  if (( status == 0 )); then
    mv "$tmp" "$pi_cache"
  else
    rm -f "$tmp"
  fi
  rmdir "$pi_lock_dir" 2>/dev/null || true
  return "$status"
}

export_active_pi_sessions() {
  # Pi status is cheap enough to refresh synchronously when stale. Rendering a
  # stale busy/idle marker is more confusing than spending ~100ms here.
  if ! cache_file_fresh "$pi_cache" "$pi_cache_ttl"; then
    refresh_pi_cache 2>/dev/null || true
  fi
  PI_SESSION_PICKER_PI_SESSIONS="$(cat "$pi_cache" 2>/dev/null || true)"
  export PI_SESSION_PICKER_PI_SESSIONS
}

sesh_lines() {
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
      printf 'Unknown sesh list mode: %s\n' "$mode" >&2
      return 2
      ;;
  esac

  local current_session
  current_session="$(current_tmux_session)"

  sesh list "${args[@]}" | CURRENT_TMUX_SESSION="$current_session" python3 -c '
import json
import os
import signal
import sys

signal.signal(signal.SIGPIPE, signal.SIG_DFL)

current_tmux_session = os.environ.get("CURRENT_TMUX_SESSION", "")

pi_sessions = {}
for line in os.environ.get("PI_SESSION_PICKER_PI_SESSIONS", "").splitlines():
    path, sep, status = line.partition("\t")
    if path and sep:
        pi_sessions[os.path.realpath(path)] = status or "idle"


GREEN = "\033[32m"
GREY = "\033[90m"
RESET = "\033[0m"


def pi_marker(path):
    if not path:
        return ""
    status = pi_sessions.get(os.path.realpath(path))
    if status == "working":
        return f"{GREEN}π{RESET} "
    if status == "idle":
        return f"{GREY}π{RESET} "
    return ""


icons = {
    "tmux": "",
    "zoxide": "",
    "config": "⚙",
    "tmuxinator": "⚙",
}

sessions = json.load(sys.stdin) or []
for session in sessions:
    src = session.get("Src", "")
    name = session.get("Name") or session.get("Path") or ""
    path = session.get("Path") or ""
    if src == "tmux" and name == current_tmux_session:
        continue
    if src in {"tmux", "config", "tmuxinator"}:
        target = session.get("Name") or name
    else:
        target = path or name
    marker = pi_marker(path or target)
    print(f"{icons.get(src, chr(0x2022))} {marker}{name}\t{target}\t{src}")
'
}

candidate_paths() {
  [[ -n "${PWD:-}" ]] && printf '%s\n' "$PWD"

  if command -v tmux >/dev/null 2>&1; then
    tmux list-panes -a -F '#{pane_current_path}' 2>/dev/null || true
  fi

  if command -v sesh >/dev/null 2>&1; then
    sesh list --json --zoxide 2>/dev/null | python3 -c '
import json
import signal
import sys

signal.signal(signal.SIGPIPE, signal.SIG_DFL)

try:
    sessions = json.load(sys.stdin) or []
except Exception:
    sessions = []
for session in sessions:
    path = session.get("Path")
    if path:
        print(path)
'
  fi

  # pi-subagents creates temporary worktrees directly under tmpdir as
  # pi-agent-<id>-<suffix>. These are usually never visited, so zoxide
  # will not learn them.
  for tmpdir in "${TMPDIR:-/tmp}" /tmp; do
    [[ -d "$tmpdir" ]] || continue
    find "$tmpdir" -maxdepth 1 -type d -name 'pi-agent-*' 2>/dev/null || true
  done
}

candidate_repo_roots() {
  candidate_paths | python3 -c '
import os
import signal
import subprocess
import sys

signal.signal(signal.SIGPIPE, signal.SIG_DFL)

raw_paths = []
seen_input = set()
for line in sys.stdin:
    path = line.rstrip("\n")
    if not path or path in seen_input or not os.path.isdir(path):
        continue
    seen_input.add(path)
    raw_paths.append(path)

# Resolve shallower paths first. Once a repo root is found, skip candidates
# beneath it so zoxide subdirectories do not cost another `git rev-parse`.
raw_paths.sort(key=lambda p: (os.path.realpath(p).count(os.sep), os.path.realpath(p)))

seen_roots = set()
root_reals = []
for path in raw_paths:
    real = os.path.realpath(path)
    if any(real == root or real.startswith(root + os.sep) for root in root_reals):
        continue

    try:
        root = subprocess.check_output(
            ["git", "-C", path, "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=1,
        ).strip()
    except Exception:
        continue

    if not root:
        continue
    root_real = os.path.realpath(root)
    if root_real in seen_roots:
        continue

    seen_roots.add(root_real)
    root_reals.append(root_real)
    print(root)
'
}

discover_worktrees_raw() {
  candidate_repo_roots | python3 -c '
import os
import signal
import subprocess
import sys

signal.signal(signal.SIGPIPE, signal.SIG_DFL)


def parse_worktree_porcelain(text):
    records = []
    current = None
    for line in text.splitlines():
        if not line:
            if current:
                records.append(current)
                current = None
            continue

        key, sep, value = line.partition(" ")
        if key == "worktree":
            if current:
                records.append(current)
            current = {"worktree": value}
        elif current is not None:
            current[key] = value if sep else True

    if current:
        records.append(current)
    return records


def repo_label(main_path):
    name = os.path.basename(main_path.rstrip(os.sep))
    parent = os.path.basename(os.path.dirname(main_path.rstrip(os.sep)))
    if name in {"main", "master", "trunk"} and parent:
        return parent
    return name or main_path


def ref_label(record):
    branch = record.get("branch")
    if branch:
        return branch.removeprefix("refs/heads/")
    head = record.get("HEAD", "")
    if "detached" in record:
        return f"detached@{head[:7]}" if head else "detached"
    return head[:7] if head else "unknown"

seen_paths = set()
seen_repos = set()

for root in [line.rstrip("\n") for line in sys.stdin if line.strip()]:
    try:
        common_dir = subprocess.check_output(
            ["git", "-C", root, "rev-parse", "--git-common-dir"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=1,
        ).strip()
    except Exception:
        common_dir = root

    if not os.path.isabs(common_dir):
        common_dir = os.path.normpath(os.path.join(root, common_dir))
    if common_dir in seen_repos:
        continue
    seen_repos.add(common_dir)

    try:
        output = subprocess.check_output(
            ["git", "-C", root, "worktree", "list", "--porcelain"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
        )
    except Exception:
        continue

    records = parse_worktree_porcelain(output)
    if len(records) <= 1:
        continue

    main_path = records[0].get("worktree", "")
    label = repo_label(main_path)

    # git lists the main worktree first. The picker already gets main repo
    # directories from tmux/zoxide, so only add linked worktrees here.
    for record in records[1:]:
        path = record.get("worktree", "")
        if not path or path in seen_paths or not os.path.isdir(path):
            continue
        seen_paths.add(path)

        branch = ref_label(record)
        locked = " 🔒" if "locked" in record else ""
        print(f"{path}\t{label}\t{branch}\t{locked}")
'
}

refresh_worktree_cache() {
  mkdir -p "$cache_dir"
  if ! acquire_cache_lock "$worktree_lock_dir" 60; then
    return 0
  fi

  local tmp status=0
  tmp="$(mktemp "$cache_dir/worktrees.XXXXXX")"
  discover_worktrees_raw >"$tmp" || status=$?
  if (( status == 0 )); then
    mv "$tmp" "$worktree_cache"
  else
    rm -f "$tmp"
  fi
  rmdir "$worktree_lock_dir" 2>/dev/null || true
  return "$status"
}

refresh_worktree_cache_async() {
  cache_file_fresh "$worktree_cache" "$worktree_cache_ttl" && return 0
  (
    refresh_worktree_cache
  ) </dev/null >/dev/null 2>&1 &
}

render_worktrees() {
  python3 -c '
import os
import signal
import sys

signal.signal(signal.SIGPIPE, signal.SIG_DFL)

ICON = ""

pi_sessions = {}
for line in os.environ.get("PI_SESSION_PICKER_PI_SESSIONS", "").splitlines():
    path, sep, status = line.partition("\t")
    if path and sep:
        pi_sessions[os.path.realpath(path)] = status or "idle"


GREEN = "\033[32m"
GREY = "\033[90m"
RESET = "\033[0m"


def pi_marker(path):
    status = pi_sessions.get(os.path.realpath(path))
    if status == "working":
        return f"{GREEN}π{RESET} "
    if status == "idle":
        return f"{GREY}π{RESET} "
    return ""


seen_paths = set()
for line in sys.stdin:
    path, label, branch, locked = (line.rstrip("\n").split("\t") + [""] * 4)[:4]
    if not path or path in seen_paths or not os.path.isdir(path):
        continue
    seen_paths.add(path)
    name = f"{pi_marker(path)}{label}:{branch}{locked}  {path}"
    print(f"{ICON} {name}\t{path}\tworktree")
'
}

list_worktrees() {
  local on_miss="${1:-async}"
  mkdir -p "$cache_dir"
  if [[ ! -f "$worktree_cache" ]]; then
    if [[ "$on_miss" == "sync" ]]; then
      refresh_worktree_cache 2>/dev/null || true
    else
      refresh_worktree_cache_async
    fi
  else
    refresh_worktree_cache_async
  fi
  [[ -f "$worktree_cache" ]] && render_worktrees <"$worktree_cache"
}

list_sessions() {
  local mode="${1:-all}"

  export_active_pi_sessions

  case "$mode" in
    all)
      sesh_lines all
      list_worktrees async
      ;;
    tmux|zoxide)
      sesh_lines "$mode"
      ;;
    worktree)
      list_worktrees sync
      ;;
    *)
      printf 'Unknown session list mode: %s\n' "$mode" >&2
      return 2
      ;;
  esac
}

selection_target() {
  local selection="$1"
  local _ target _src
  IFS=$'\t' read -r _ target _src <<<"$selection"
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
    list_sessions "${2:-all}"
    exit 0
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
list_sessions all | fzf \
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
