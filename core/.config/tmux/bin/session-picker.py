#!/usr/bin/env python3
"""Row producer for the tmux session picker (driven by session-picker.sh).

Commands:
  list [all|tmux|zoxide|worktree]   print picker rows
  status                            tmux status-line pi summary
  refresh-worktrees                 rebuild the worktree cache (internal)

Row contract: "<icon> <markers><name>  <detail>\\t<target>\\t<src>"

fzf matches against the rendered first field (since fzf 0.52, --nth cannot
reach fields hidden by --with-nth), so the display doubles as the search
corpus and ranking depends on its shape. Every renderer must keep the
contract: a one-char icon + space + fixed-width marker slot (two chars per
entry in AGENTS: "π " pi, "✻ " Claude Code, spaces when absent), then the
session/repo name, then detail (path, branch). With names starting at the
same column on every row, the begin tiebreak is even across sources and the
length tiebreak ranks shorter rows -- sessions and parent repos -- above
their longer worktree rows.

Rows from different sources that resolve to the same directory are deduped:
tmux/config sessions beat worktree rows, which beat plain zoxide rows. The
winning row is emitted at the position of the duplicate seen first, so
zoxide frecency still decides where a repo appears in the unfiltered list.

Working/idle markers come from heartbeat files (one JSON file per agent
process): ~/.cache/pi-status/ written by the pi-status pi extension and
~/.cache/claude-status/ written by the claude-status-hook Claude Code hook.
Files whose pid is gone are treated as stale and removed.
"""

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from collections import namedtuple

XDG_CACHE = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
CACHE_DIR = os.path.join(XDG_CACHE, "tmux-session-picker")
WORKTREE_CACHE = os.path.join(CACHE_DIR, "worktrees.tsv")
WORKTREE_LOCK = os.path.join(CACHE_DIR, "worktrees.lock")
WORKTREE_TTL = 60

# Heartbeat sources in marker-slot order: (key, status dir, marker char).
AGENTS = (
    ("pi", os.path.join(XDG_CACHE, "pi-status"), "π"),
    ("claude", os.path.join(XDG_CACHE, "claude-status"), "✻"),
)

GREEN = "\033[32m"
GREY = "\033[90m"
RESET = "\033[0m"

ICONS = {
    "tmux": "",
    "zoxide": "",
    "config": "⚙",
    "tmuxinator": "⚙",
    "worktree": "",
}
DEFAULT_ICON = "•"

# Lower wins a dedup. Sessions (attach) beat worktree rows (richer label,
# same connect action) which beat plain directory rows.
PRIORITY = {"tmux": 0, "config": 0, "tmuxinator": 0, "worktree": 1}
DEFAULT_PRIORITY = 2

Row = namedtuple("Row", ["display", "target", "src", "key", "priority"])


def run(cmd, timeout):
    try:
        return subprocess.check_output(
            cmd, stderr=subprocess.DEVNULL, text=True, timeout=timeout
        )
    except Exception:
        return ""


# ── pi heartbeat files ────────────────────────────────────────────────────────


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False
    return True


def read_agent_records(status_dir, alive=pid_alive):
    """Heartbeat records for live agent processes; stale files are removed."""
    records = []
    try:
        names = os.listdir(status_dir)
    except OSError:
        return records
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(status_dir, name)
        try:
            with open(path) as fh:
                data = json.load(fh)
        except Exception:
            continue
        pid = data.get("pid")
        if not isinstance(pid, int) or not alive(pid):
            try:
                os.unlink(path)
            except OSError:
                pass
            continue
        cwd = data.get("cwd")
        if not cwd:
            continue
        records.append(
            {
                "pid": pid,
                "cwd": cwd,
                "status": data.get("status") or "idle",
                "interactive": bool(data.get("interactive")),
            }
        )
    return records


def git_root(path):
    cur = os.path.realpath(path)
    while cur and cur != os.path.dirname(cur):
        if os.path.exists(os.path.join(cur, ".git")):
            return cur
        cur = os.path.dirname(cur)
    return os.path.realpath(path)


def agent_roots(records, root_of=git_root):
    """Map realpath(git root) -> status. Working wins over idle per root."""
    roots = {}
    for record in records:
        root = os.path.realpath(root_of(record["cwd"]))
        if roots.get(root) != "working":
            roots[root] = record["status"]
    return roots


def read_all_agents(agents=AGENTS, alive=pid_alive):
    """Map agent key -> heartbeat records."""
    return {key: read_agent_records(status_dir, alive) for key, status_dir, _ in agents}


def agent_markers(path, roots_by_agent, agents=AGENTS):
    """One fixed-width sub-slot per agent so names start at the same column
    on every row; the begin tiebreak counts the marker slot either way."""
    real = os.path.realpath(path) if path else None
    slots = []
    for key, _, char in agents:
        status = roots_by_agent.get(key, {}).get(real) if real else None
        if status == "working":
            slots.append(f"{GREEN}{char}{RESET} ")
        elif status:
            slots.append(f"{GREY}{char}{RESET} ")
        else:
            slots.append("  ")
    return "".join(slots)


def status_summary(records_by_agent, agents=AGENTS):
    """Compact agent summary for the tmux status line (tmux style markup).

    Counts interactive sessions only (one per git root) so headless
    subagent runs do not inflate the numbers. Returns "" when nothing runs.
    """
    parts = []
    for key, _, char in agents:
        roots = agent_roots([r for r in records_by_agent.get(key, []) if r["interactive"]])
        working = sum(1 for status in roots.values() if status == "working")
        idle = len(roots) - working
        if working:
            parts.append(f"#[fg=#a6e3a1,bg=#1e1e2e]{char}{working}")
        if idle:
            parts.append(f"#[fg=#6c7086,bg=#1e1e2e]{char}{idle}")
    return " ".join(parts) + " " if parts else ""


# ── sesh rows ─────────────────────────────────────────────────────────────────


def current_tmux_session():
    if not os.environ.get("TMUX"):
        return ""
    return run(["tmux", "display-message", "-p", "#S"], timeout=2).strip()


def sesh_json(mode):
    args = {"all": ["--hide-duplicates"], "tmux": ["--tmux"], "zoxide": ["--zoxide"]}[mode]
    out = run(["sesh", "list", "--json"] + args, timeout=5)
    try:
        return json.loads(out) or []
    except Exception:
        return []


def build_sesh_rows(sessions, roots_by_agent, current_session):
    rows = []
    for session in sessions:
        src = session.get("Src", "")
        name = session.get("Name") or session.get("Path") or ""
        path = session.get("Path") or ""
        if src == "tmux" and name == current_session:
            continue
        if src in ("tmux", "config", "tmuxinator"):
            target = session.get("Name") or name
            label = name
        else:
            target = path or name
            # Directory basename leads so repo-name queries match at the
            # name column like every other source; the path keeps fragments
            # matchable.
            base = os.path.basename(target.rstrip(os.sep))
            label = f"{base}  {name}" if base and base != name else name
        marker = agent_markers(path or target, roots_by_agent)
        display = f"{ICONS.get(src, DEFAULT_ICON)} {marker}{label}"
        key = os.path.realpath(path) if path else None
        rows.append(Row(display, target, src, key, PRIORITY.get(src, DEFAULT_PRIORITY)))
    return rows


# ── worktree discovery ────────────────────────────────────────────────────────


def candidate_paths():
    paths = [os.getcwd()]
    paths += run(["tmux", "list-panes", "-a", "-F", "#{pane_current_path}"], timeout=2).splitlines()
    for session in sesh_json("zoxide"):
        if session.get("Path"):
            paths.append(session["Path"])
    # pi-subagents creates temporary worktrees directly under tmpdir as
    # pi-agent-<id>-<suffix>. These are usually never visited, so zoxide
    # will not learn them.
    for tmpdir in (os.environ.get("TMPDIR") or "/tmp", "/tmp"):
        try:
            for name in os.listdir(tmpdir):
                if name.startswith("pi-agent-"):
                    paths.append(os.path.join(tmpdir, name))
        except OSError:
            pass
    return paths


def candidate_repo_roots(paths):
    raw_paths = []
    seen_input = set()
    for path in paths:
        if not path or path in seen_input or not os.path.isdir(path):
            continue
        seen_input.add(path)
        raw_paths.append(path)

    # Resolve shallower paths first. Once a repo root is found, skip
    # candidates beneath it so zoxide subdirectories do not cost another
    # `git rev-parse`.
    raw_paths.sort(key=lambda p: (os.path.realpath(p).count(os.sep), os.path.realpath(p)))

    seen_roots = set()
    root_reals = []
    roots = []
    for path in raw_paths:
        real = os.path.realpath(path)
        if any(real == root or real.startswith(root + os.sep) for root in root_reals):
            continue
        root = run(["git", "-C", path, "rev-parse", "--show-toplevel"], timeout=1).strip()
        if not root:
            continue
        root_real = os.path.realpath(root)
        if root_real in seen_roots:
            continue
        seen_roots.add(root_real)
        root_reals.append(root_real)
        roots.append(root)
    return roots


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
    if name in ("main", "master", "trunk") and parent:
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


def discover_worktree_lines(roots):
    lines = []
    seen_paths = set()
    seen_repos = set()
    for root in roots:
        common_dir = run(["git", "-C", root, "rev-parse", "--git-common-dir"], timeout=1).strip()
        if not common_dir:
            common_dir = root
        if not os.path.isabs(common_dir):
            common_dir = os.path.normpath(os.path.join(root, common_dir))
        if common_dir in seen_repos:
            continue
        seen_repos.add(common_dir)

        output = run(["git", "-C", root, "worktree", "list", "--porcelain"], timeout=2)
        records = parse_worktree_porcelain(output)
        if len(records) <= 1:
            continue

        label = repo_label(records[0].get("worktree", ""))
        # git lists the main worktree first. The picker already gets main
        # repo directories from tmux/zoxide, so only add linked worktrees.
        for record in records[1:]:
            path = record.get("worktree", "")
            if not path or path in seen_paths or not os.path.isdir(path):
                continue
            seen_paths.add(path)
            branch = ref_label(record)
            locked = " \U0001f512" if "locked" in record else ""
            lines.append(f"{path}\t{label}\t{branch}\t{locked}")
    return lines


def build_worktree_rows(cache_lines, roots_by_agent, isdir=os.path.isdir):
    rows = []
    seen_paths = set()
    for line in cache_lines:
        path, label, branch, locked = (line.rstrip("\n").split("\t") + [""] * 4)[:4]
        if not path or path in seen_paths or not isdir(path):
            continue
        seen_paths.add(path)
        marker = agent_markers(path, roots_by_agent)
        display = f"{ICONS['worktree']} {marker}{label}:{branch}{locked}  {path}"
        rows.append(Row(display, path, "worktree", os.path.realpath(path), PRIORITY["worktree"]))
    return rows


# ── worktree cache ────────────────────────────────────────────────────────────


def cache_fresh(path, ttl):
    try:
        return time.time() - os.stat(path).st_mtime < ttl
    except OSError:
        return False


def acquire_lock(lock_dir, stale_after=300):
    try:
        os.mkdir(lock_dir)
        return True
    except FileExistsError:
        pass
    except OSError:
        return False
    try:
        if time.time() - os.stat(lock_dir).st_mtime > stale_after:
            os.rmdir(lock_dir)
            os.mkdir(lock_dir)
            return True
    except OSError:
        pass
    return False


def refresh_worktree_cache():
    os.makedirs(CACHE_DIR, exist_ok=True)
    if not acquire_lock(WORKTREE_LOCK, stale_after=60):
        return
    try:
        lines = discover_worktree_lines(candidate_repo_roots(candidate_paths()))
        fd, tmp = tempfile.mkstemp(prefix="worktrees.", dir=CACHE_DIR)
        with os.fdopen(fd, "w") as fh:
            fh.write("".join(line + "\n" for line in lines))
        os.replace(tmp, WORKTREE_CACHE)
    finally:
        try:
            os.rmdir(WORKTREE_LOCK)
        except OSError:
            pass


def refresh_worktree_cache_async():
    if cache_fresh(WORKTREE_CACHE, WORKTREE_TTL):
        return
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "refresh-worktrees"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def cached_worktree_lines(on_miss):
    # Block only when there is no cache at all; a stale cache still renders
    # instantly while the async refresh catches up.
    if on_miss == "sync" and not os.path.exists(WORKTREE_CACHE):
        refresh_worktree_cache()
    else:
        refresh_worktree_cache_async()
    try:
        with open(WORKTREE_CACHE) as fh:
            return fh.readlines()
    except OSError:
        return []


# ── assembly ──────────────────────────────────────────────────────────────────


def dedupe(rows):
    """Collapse rows that resolve to the same directory.

    The best-priority row wins but is emitted at the position of the first
    row seen for that directory, preserving source order / zoxide frecency.
    """
    best = {}
    for row in rows:
        if row.key and (row.key not in best or row.priority < best[row.key].priority):
            best[row.key] = row
    out = []
    seen = set()
    for row in rows:
        if not row.key:
            out.append(row)
            continue
        if row.key in seen:
            continue
        seen.add(row.key)
        out.append(best[row.key])
    return out


def emit(rows):
    for row in rows:
        sys.stdout.write(f"{row.display}\t{row.target}\t{row.src}\n")


def cmd_list(mode):
    roots_by_agent = {key: agent_roots(records) for key, records in read_all_agents().items()}
    if mode == "worktree":
        emit(build_worktree_rows(cached_worktree_lines("sync"), roots_by_agent))
        return 0
    if mode in ("tmux", "zoxide"):
        emit(build_sesh_rows(sesh_json(mode), roots_by_agent, current_tmux_session()))
        return 0
    if mode != "all":
        print(f"Unknown session list mode: {mode}", file=sys.stderr)
        return 2
    rows = build_sesh_rows(sesh_json("all"), roots_by_agent, current_tmux_session())
    rows += build_worktree_rows(cached_worktree_lines("async"), roots_by_agent)
    emit(dedupe(rows))
    return 0


def main(argv):
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "list":
        return cmd_list(argv[2] if len(argv) > 2 else "all")
    if cmd == "status":
        summary = status_summary(read_all_agents())
        if summary:
            sys.stdout.write(summary + "\n")
        return 0
    if cmd == "refresh-worktrees":
        refresh_worktree_cache()
        return 0
    print(f"Usage: {os.path.basename(argv[0])} list|status|refresh-worktrees", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
