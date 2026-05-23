#!/usr/bin/env bash
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
quoted_script_path="$(printf '%q' "$script_path")"

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

  sesh list "${args[@]}" | python3 -c '
import json
import signal
import sys

signal.signal(signal.SIGPIPE, signal.SIG_DFL)

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
    if src in {"tmux", "config", "tmuxinator"}:
        target = session.get("Name") or name
    else:
        target = session.get("Path") or name
    print(f"{icons.get(src, "•")} {name}\t{target}\t{src}")
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

list_worktrees() {
  candidate_repo_roots | python3 -c '
import os
import signal
import subprocess
import sys

signal.signal(signal.SIGPIPE, signal.SIG_DFL)

ICON = ""


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
        name = f"{label}:{branch}{locked}  {path}"
        print(f"{ICON} {name}\t{path}\tworktree")
'
}

list_sessions() {
  local mode="${1:-all}"

  case "$mode" in
    all)
      sesh_lines all
      list_worktrees
      ;;
    tmux|zoxide)
      sesh_lines "$mode"
      ;;
    worktree)
      list_worktrees
      ;;
    *)
      printf 'Unknown session list mode: %s\n' "$mode" >&2
      return 2
      ;;
  esac
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

# If the user selects an entry while the producer is still streaming, fzf exits
# successfully and the producer gets SIGPIPE. With global pipefail enabled that
# would make the whole pipeline look failed and skip the selected session.
set +o pipefail
if ! selection="$(list_sessions all | fzf \
  --no-tmux \
  --delimiter=$'\t' \
  --with-nth=1 \
  --height=100% \
  --border-label=' Sessions ' \
  --prompt='> ' \
  --header='enter: connect · ctrl-a: all · ctrl-t: tmux · ctrl-z: zoxide · ctrl-w: worktrees · ctrl-d: kill tmux session' \
  --reverse \
  --algo=v1 \
  --tiebreak=begin,length \
  --bind='tab:down,btab:up' \
  --bind="ctrl-a:change-prompt(> )+reload($quoted_script_path --list all)" \
  --bind="ctrl-t:change-prompt( )+reload($quoted_script_path --list tmux)" \
  --bind="ctrl-z:change-prompt( )+reload($quoted_script_path --list zoxide)" \
  --bind="ctrl-w:change-prompt( )+reload($quoted_script_path --list worktree)" \
  --bind="ctrl-d:execute-silent($quoted_script_path --kill {})+reload($quoted_script_path --list all)" \
  --preview-window=hidden \
  --info=inline \
  --padding=1)"; then
  set -o pipefail
  exit 0
fi
set -o pipefail

[[ -n "$selection" ]] || exit 0

IFS=$'\t' read -r _ target _ <<<"$selection"
[[ -n "$target" ]] || exit 0

exec sesh connect --switch "$target"
