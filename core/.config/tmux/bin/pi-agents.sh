#!/usr/bin/env bash
set -uo pipefail

script_path="${BASH_SOURCE[0]}"
quoted_script_path="$(printf '%q' "$script_path")"

RUNNING_MINUTES=10

shorten_uuid() { echo "${1:0:8}"; }
project_name() { printf '%s' "$1" | sed 's/^--//;s/--$//;s/-/\//g'; }

# Collect cwd of all live pi processes. Used by composite status detection.
get_alive_pi_cwds() {
    local pids
    pids="$(pgrep -x pi 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
    [[ -n "$pids" ]] || return 0
    lsof -p "$pids" -a -d cwd 2>/dev/null | awk 'NR>1 {print $NF}' | sort -u
}

# Composite status detection for a single .output file.
# Signals: C = record in parent session jsonl (done), B = pi alive in cwd (running),
# A = last-entry heuristic (fallback when pi dead and no record).
get_agent_status() {
    local f="$1"
    python3 -c '
import sys, os, json, subprocess, glob, mmap, re

path = sys.argv[1]

record_re = re.compile(rb"\"subagents:record\"[^\n]*?\"id\":\"([^\"]+)\"")
alive_cwds = set()
try:
    pids = subprocess.run(["pgrep", "-x", "pi"], capture_output=True, text=True, timeout=5)
    if pids.returncode == 0 and pids.stdout.strip():
        pid_list = pids.stdout.strip().replace("\n", ",")
        lsof = subprocess.run(["lsof", "-p", pid_list, "-a", "-d", "cwd"], capture_output=True, text=True, timeout=10)
        if lsof.returncode == 0:
            for line in lsof.stdout.strip().split("\n")[1:]:
                parts = line.split()
                if parts:
                    alive_cwds.add(parts[-1])
except Exception:
    pass

def first_line(p):
    try:
        with open(p, "r", errors="ignore") as f:
            return f.readline().strip()
    except Exception:
        return ""

def last_line(p):
    try:
        with open(p, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            if size == 0:
                return ""
            chunk_size = min(size, 8192)
            f.seek(size - chunk_size)
            data = f.read().decode("utf-8", errors="ignore")
            lines = [l for l in data.split("\n") if l.strip()]
            return lines[-1] if lines else ""
    except Exception:
        return ""

def fallback_status(line):
    if not line:
        return "running"
    try:
        d = json.loads(line)
    except Exception:
        return "running"
    msg = d.get("message", {}) if isinstance(d.get("message"), dict) else {}
    content = msg.get("content", []) if isinstance(msg.get("content"), list) else []
    t = d.get("type", "")
    if t in ("user", "toolResult"):
        return "running"
    if t == "assistant":
        has_tools = any(isinstance(c, dict) and c.get("type") == "toolCall" for c in content)
        return "running" if has_tools else "done"
    return "running"

fl = first_line(path)
cwd = ""
try:
    if fl:
        cwd = json.loads(fl).get("cwd", "") or ""
except Exception:
    pass

parts = path.split("/")
sid = parts[-3] if len(parts) >= 3 else ""
aid = os.path.splitext(parts[-1])[0] if parts else ""

records = set()
if sid:
    matches = glob.glob(os.path.expanduser(f"~/.pi/agent/sessions/*/*_{sid}.jsonl"))
    if matches:
        try:
            with open(matches[0], "rb") as f:
                size = os.fstat(f.fileno()).st_size
                if size > 0:
                    with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                        records = {m.group(1).decode("utf-8", "replace") for m in record_re.finditer(mm)}
        except Exception:
            pass

ll = last_line(path)
fb = fallback_status(ll)

if aid in records:
    print("done")
elif cwd and cwd in alive_cwds:
    print("running")
elif fb == "running":
    print("crashed")
else:
    print("done")
' "$f"
}

# ---------------------------------------------------------------------------
# List sources
# ---------------------------------------------------------------------------

list_subagents() {
    local max_age_hours="${1:-24}"
    local py
    py="$(cat <<'PY'
import sys, os, json, time, subprocess, glob, mmap, re

# Phase 0 — collect live pi cwds and prepare regex
alive_cwds = set()
try:
    pids = subprocess.run(["pgrep", "-x", "pi"], capture_output=True, text=True, timeout=5)
    if pids.returncode == 0 and pids.stdout.strip():
        pid_list = pids.stdout.strip().replace("\n", ",")
        lsof = subprocess.run(["lsof", "-p", pid_list, "-a", "-d", "cwd"], capture_output=True, text=True, timeout=10)
        if lsof.returncode == 0:
            for line in lsof.stdout.strip().split("\n")[1:]:
                parts = line.split()
                if parts:
                    alive_cwds.add(parts[-1])
except Exception:
    pass

record_re = re.compile(rb"\"subagents:record\"[^\n]*?\"id\":\"([^\"]+)\"")

def scan_records(path):
    try:
        with open(path, "rb") as f:
            size = os.fstat(f.fileno()).st_size
            if size == 0:
                return set()
            with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                return {m.group(1).decode("utf-8", "replace") for m in record_re.finditer(mm)}
    except Exception:
        return set()

max_age_hours = int(os.environ.get("MAX_AGE_HOURS", "24"))
now = int(time.time())
max_diff = max_age_hours * 3600 if max_age_hours > 0 else 0

def short(u):
    return u[:8]

def project_from_slug(slug):
    s = slug
    while s.startswith("--"):
        s = s[2:]
    while s.endswith("--"):
        s = s[:-2]
    return s.replace("-", "/")

def first_line(path):
    try:
        with open(path, "r", errors="ignore") as f:
            return f.readline().strip()
    except Exception:
        return ""

def last_line(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            if size == 0:
                return ""
            chunk_size = min(size, 8192)
            f.seek(size - chunk_size)
            data = f.read().decode("utf-8", errors="ignore")
            lines = [l for l in data.split("\n") if l.strip()]
            return lines[-1] if lines else ""
    except Exception:
        return ""

def fallback_status(line):
    if not line:
        return "running"
    try:
        d = json.loads(line)
    except Exception:
        return "running"
    msg = d.get("message", {}) if isinstance(d.get("message"), dict) else {}
    content = msg.get("content", []) if isinstance(msg.get("content"), list) else []
    t = d.get("type", "")
    if t in ("user", "toolResult"):
        return "running"
    if t == "assistant":
        has_tools = any(isinstance(c, dict) and c.get("type") == "toolCall" for c in content)
        return "running" if has_tools else "done"
    return "running"

# Phase 1 — read and group agents by session_id
agents = []
session_to_agents = {}

for path in sys.stdin:
    path = path.rstrip("\n")
    if not path:
        continue
    try:
        st = os.stat(path)
    except Exception:
        continue
    mtime = int(st.st_mtime)
    diff = now - mtime
    if max_diff > 0 and diff > max_diff:
        continue

    parts = path.split("/")
    if len(parts) < 5:
        continue
    agent_id = os.path.splitext(parts[-1])[0]
    session_id = parts[-3]
    slug = parts[-4]

    fl = first_line(path)
    cwd = ""
    try:
        if fl:
            cwd = json.loads(fl).get("cwd", "") or ""
    except Exception:
        pass
    project = cwd if cwd else project_from_slug(slug)

    ll = last_line(path)
    fb_status = fallback_status(ll)

    idx = len(agents)
    agents.append({
        "path": path,
        "agent_id": agent_id,
        "session_id": session_id,
        "cwd": cwd,
        "project": project,
        "mtime": mtime,
        "fallback_status": fb_status,
    })
    session_to_agents.setdefault(session_id, []).append(idx)

# Phase 2 — scan parent session jsonls for subagents:record
session_records = {}
for sid in session_to_agents:
    matches = glob.glob(os.path.expanduser(f"~/.pi/agent/sessions/*/*_{sid}.jsonl"))
    if matches:
        session_records[sid] = scan_records(matches[0])

# Phase 3 — composite status and emit TSV
for agent in agents:
    sid = agent["session_id"]
    aid = agent["agent_id"]
    cwd = agent["cwd"]
    fb = agent["fallback_status"]

    records = session_records.get(sid, set())
    if aid in records:
        status = "done"
    elif cwd and cwd in alive_cwds:
        status = "running"
    elif fb == "running":
        status = "crashed"
    else:
        status = "done"

    icon = "🔄" if status == "running" else "✅" if status == "done" else "⚠️"
    mtime_human = time.strftime("%m/%d %H:%M", time.localtime(agent["mtime"]))
    print(f"subagent\t{icon}\t{agent['project']}\t{short(sid)}\t{short(aid)}\t{status}\t{agent['mtime']}\t{mtime_human}\t{agent['path']}")
PY
)"
    find /var/folders -maxdepth 4 -type d -name 'pi-subagents-*' 2>/dev/null | \
    while read -r d; do [[ -n "$d" ]] || continue; find "$d" -path '*/tasks/*.output' -type f 2>/dev/null; done | \
    MAX_AGE_HOURS="$max_age_hours" python3 -c "$py"
}

list_tmux_pis() {
    local now
    now="$(date +%s)"
    while read -r target pane_pid win_name cwd; do
        [[ "$win_name" == "node" ]] || continue
        local is_pi=false cpid comm
        while read -r cpid; do
            comm="$(ps -p "$cpid" -o comm= 2>/dev/null || true)"
            [[ "$comm" == "pi" ]] && { is_pi=true; break; }
        done < <(pgrep -P "$pane_pid" 2>/dev/null || true)
        [[ "$is_pi" == true ]] || continue
        printf "tmux\t\t%s\t%s\t%s\tactive\t%s\tnow\t%s\n" \
            "$cwd" "$target" "${win_name:-$target}" "$now" "$target"
    done < <(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_pid} #{window_name} #{pane_current_path}' 2>/dev/null || true)
}

list_saved_sessions() {
    local sessions_dir="${HOME}/.pi/agent/sessions"
    [[ -d "$sessions_dir" ]] || return 0
    find "$sessions_dir" -name '*.jsonl' -type f -mtime -7 2>/dev/null | sort -r | head -30 | \
    python3 -c '
import json, sys, subprocess, os
for path in sys.stdin:
    path = path.strip()
    if not path: continue
    try:
        with open(path) as f: header = f.readline()
        if not header: continue
        d = json.loads(header)
        sid = d.get("id", "?")[:8]
        cwd = d.get("cwd", "?")
        # BSD stat; GNU stat uses -c instead of -f
        stat = subprocess.run(["stat", "-f", "%Sm", "-t", "%m/%d %H:%M", path], capture_output=True, text=True)
        mtime = stat.stdout.strip() if stat.returncode == 0 else "?"
        epoch = int(os.path.getmtime(path))
        print(f"session\t📋\t{cwd}\t{sid}\tsaved\tdisk\t{epoch}\t{mtime}\t{path}")
    except Exception:
        pass
'
}

build_list() {
    local max_age_hours="${1:-24}" tmpfile="$2"
    : > "$tmpfile"
    {
        list_subagents "$max_age_hours" 2>/dev/null
        list_tmux_pis 2>/dev/null
        list_saved_sessions 2>/dev/null
    } | sort -t$'\t' -k7,7nr >> "$tmpfile" || true
}

preview_item() {
    local line="$1" kind icon project id label status mtime target
    IFS=$'\t' read -r kind icon project id label status epoch mtime target <<< "$line"
    case "$kind" in
        subagent)
            AGENT_FILE="$target" AGENT_PROJECT="$project" AGENT_ID="$label" python3 <<'PY'
import json, os, textwrap

path = os.environ["AGENT_FILE"]
project = os.environ["AGENT_PROJECT"]
agent_id = os.environ["AGENT_ID"]

MAX_TEXT = 300
MAX_TOOL_ARGS = 60
RESULT_SNIP = 70

raw_lines = []
with open(path, "r", errors="ignore") as f:
    for line in f:
        line = line.strip()
        if line:
            raw_lines.append(line)

entries = []
tool_results = {}
for raw in raw_lines:
    try:
        d = json.loads(raw)
        t = d.get("type")
        msg = d.get("message", {}) if isinstance(d.get("message"), dict) else {}
        if t == "user" or (t == "message" and msg.get("role") == "user"):
            content = msg.get("content", "")
            text = ""
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        text = c.get("text", "")
                        break
            if text.strip():
                entries.append(("user", text.strip()))
        elif t == "assistant":
            content = msg.get("content", [])
            texts = []
            tools = []
            if isinstance(content, list):
                for c in content:
                    if not isinstance(c, dict):
                        continue
                    ct = c.get("type")
                    if ct in ("text", "thinking"):
                        txt = c.get("text", c.get("thinking", "")).strip()
                        if txt:
                            texts.append(txt)
                    elif ct == "toolCall":
                        name = c.get("name", "?")
                        args = c.get("arguments", {})
                        arg_str = json.dumps(args, ensure_ascii=False)
                        if len(arg_str) > MAX_TOOL_ARGS:
                            arg_str = arg_str[:MAX_TOOL_ARGS - 3] + "..."
                        tools.append((name, arg_str, c.get("id", "")))
            if texts or tools:
                entries.append(("assistant", texts, tools))
        elif t == "toolResult":
            tid = msg.get("toolCallId", "")
            if tid:
                tool_results[tid] = (
                    msg.get("toolName", ""),
                    msg.get("isError", False),
                    msg.get("content", []),
                )
    except Exception:
        pass

last_user = ""
last_assistant_text = ""
last_assistant_idx = -1
for i in range(len(entries) - 1, -1, -1):
    kind = entries[i][0]
    if kind == "user" and not last_user:
        last_user = entries[i][1]
    if kind == "assistant":
        if last_assistant_idx == -1:
            last_assistant_idx = i
        if len(entries[i]) > 2 and entries[i][2]:
            last_assistant_idx = i
            break
if last_assistant_idx >= 0 and entries[last_assistant_idx][0] == "assistant":
    texts = entries[last_assistant_idx][1]
    if texts:
        last_assistant_text = texts[-1]

recent_tools = []
if last_assistant_idx >= 0:
    assist = entries[last_assistant_idx]
    if assist[0] == "assistant" and len(assist) > 2:
        for name, arg_str, tid in assist[2]:
            res = tool_results.get(tid)
            if res:
                _, is_err, rcontent = res
                rtext = ""
                if isinstance(rcontent, list):
                    for c in rcontent:
                        if isinstance(c, dict) and c.get("type") == "text":
                            rtext = c.get("text", "")
                            break
                first_line = rtext.split("\n")[0] if rtext else ""
                rdisplay = first_line[:RESULT_SNIP] if first_line else "(empty)"
                if rtext and (len(rtext.split("\n")) > 1 or len(first_line) > RESULT_SNIP):
                    rdisplay += "..."
                recent_tools.append((name, arg_str, is_err, rdisplay))
            else:
                recent_tools.append((name, arg_str, None, "(pending)"))

tool_counts = {}
for entry in entries:
    if entry[0] == "assistant" and len(entry) > 2:
        for name, _, _ in entry[2]:
            tool_counts[name] = tool_counts.get(name, 0) + 1

def snip(text, limit):
    text = " ".join(text.split())
    return text[:limit - 3] + "..." if len(text) > limit else text

turn_count = len([e for e in entries if e[0] in ("user", "assistant")])
print(f"📦 {project}  🆔 {agent_id}")
print(f"📄 {path}")
print(f"📊 {len(raw_lines)} entries  |  {turn_count} turns")
print("")

if last_user:
    print("👤 LAST PROMPT")
    for line in textwrap.wrap(snip(last_user, MAX_TEXT), width=74, initial_indent="  ", subsequent_indent="  "):
        print(line)
    print("")

if last_assistant_text:
    print("🤖 LAST RESPONSE")
    for line in textwrap.wrap(snip(last_assistant_text, MAX_TEXT), width=74, initial_indent="  ", subsequent_indent="  "):
        print(line)
    print("")

if recent_tools:
    print("🔧 RECENT TOOLS")
    for name, arg_str, is_err, result in recent_tools[-3:]:
        mark = "❌" if is_err else "✅" if is_err is False else "⏳"
        call = f"  {mark} {name}"
        if arg_str and arg_str not in ("{}", '""'):
            call += f"({arg_str})"
        if len(call) > 78:
            call = call[:75] + "..."
        print(call)
        if result:
            print(f"    └─ {result}")
    print("")

if tool_counts:
    tool_summary = "  ".join(f"{n}x {name}" for name, n in sorted(tool_counts.items(), key=lambda x: -x[1])[:6])
    print(f"📈 TOTAL: {tool_summary}")
    print("")

if not raw_lines:
    print("(no parseable entries)")
PY
            2>/dev/null || tail -n 30 "$target" 2>/dev/null
            ;;
        tmux)
            TMUX_TARGET="$target" TMUX_PROJECT="$project" python3 <<'PY'
import subprocess, os
target = os.environ["TMUX_TARGET"]
project = os.environ["TMUX_PROJECT"]

print(f"  Active Tmux Pane: {target}")
print(f"   CWD: {project}")
print("")

# Try to get pane PID and running command
try:
    out = subprocess.run(
        ["tmux", "list-panes", "-F", "#{pane_pid} #{pane_current_command}", "-t", target],
        capture_output=True, text=True, timeout=1
    )
    if out.returncode == 0:
        parts = out.stdout.strip().split()
        if len(parts) >= 2:
            pid, cmd = parts[0], parts[1]
            print(f"   PID: {pid}  Command: {cmd}")
            # Try to get actual process name
            ps_out = subprocess.run(["ps", "-p", pid, "-o", "comm="], capture_output=True, text=True, timeout=1)
            if ps_out.returncode == 0:
                comm = ps_out.stdout.strip()
                if comm and comm != cmd:
                    print(f"   Process: {comm}")
            # List child processes
            children = subprocess.run(["pgrep", "-P", pid], capture_output=True, text=True, timeout=1)
            if children.returncode == 0 and children.stdout.strip():
                child_pids = children.stdout.strip().split("\n")[:4]
                child_names = []
                for cpid in child_pids:
                    cps = subprocess.run(["ps", "-p", cpid, "-o", "comm="], capture_output=True, text=True, timeout=1)
                    if cps.returncode == 0:
                        child_names.append(cps.stdout.strip())
                if child_names:
                    print(f"   Children: {', '.join(child_names)}")
except Exception:
    pass

print("")

# Try capture-pane but be smart about TUI output
try:
    out = subprocess.run(
        ["tmux", "capture-pane", "-p", "-S", "-20", "-t", target],
        capture_output=True, text=True, timeout=2
    )
    if out.returncode == 0:
        lines = out.stdout.strip().split("\n")
        # Filter out TUI junk (lines that are just borders/spaces)
        def is_border_line(line, threshold=0.85):
            if not line.strip():
                return True
            box_or_space = sum(1 for ch in line if ch.isspace() or 0x2500 <= ord(ch) <= 0x259F)
            return (box_or_space / len(line)) >= threshold

        content_lines = []
        for line in reversed(lines):
            if line.strip() and not is_border_line(line):
                content_lines.append(line[:100])
            if len(content_lines) >= 15:
                break
        if content_lines:
            for line in reversed(content_lines):
                print(f"  {line}")
        else:
            print("  (pane shows TUI, no text output)")
    else:
        err = out.stderr.strip()[:80]
        print(f"  (cannot capture: {err})")
except Exception as e:
    print(f"  (error: {e})")
PY
            2>/dev/null || echo "Target: $target  CWD: $project"
            ;;
        session)
            SESS_FILE="$target" SESS_PROJECT="$project" SESS_ID="$id" python3 <<'PY'
import json, os

path = os.environ["SESS_FILE"]
project = os.environ["SESS_PROJECT"]
sid = os.environ["SESS_ID"]

entries = []
with open(path, "r", errors="ignore") as f:
    for line in f:
        line = line.strip()
        if line:
            try:
                d = json.loads(line)
                t = d.get("type")
                if t == "session":
                    meta = d
                elif t == "message":
                    msg = d.get("message", {})
                    role = msg.get("role", "?")
                    content = msg.get("content", [])
                    text = ""
                    tools = []
                    if isinstance(content, list):
                        for c in content:
                            if not isinstance(c, dict):
                                continue
                            ct = c.get("type")
                            if ct == "text":
                                if not text:
                                    text = c.get("text", "")
                            elif ct in ("tool_use", "toolUse", "toolCall"):
                                tname = c.get("name", "?")
                                tinput = c.get("input", c.get("arguments", {}))
                                try:
                                    t_str = json.dumps(tinput, ensure_ascii=False)
                                except Exception:
                                    t_str = str(tinput)
                                if len(t_str) > 40:
                                    t_str = t_str[:37] + "..."
                                tools.append(f"{tname}({t_str})")
                            elif ct in ("tool_result", "toolResult"):
                                ok = "❌" if c.get("is_error") or c.get("isError") else "✅"
                                tools.append(f"{ok} result")
                    if tools:
                        entries.append(("TOOLS", "  ".join(tools[-3:])))
                    if text.strip():
                        entries.append((role.upper(), text.strip()))
                elif t == "model_change":
                    prov = d.get("provider", "?")
                    model = d.get("model", "?")
                    entries.append(("MODEL", prov + "/" + model))
            except Exception:
                pass

import textwrap

print("📋  Saved Session  🆔 " + sid)
print("📁  " + project)
print("📄  " + path)
print("")

for role, text in entries[-8:]:
    icon = "👤" if role == "USER" else "🤖" if role == "ASSISTANT" else "⚙️"
    # Normalize whitespace and truncate very long messages
    display = " ".join(text.split())
    if len(display) > 400:
        display = display[:397] + "..."
    for line in textwrap.wrap(display, width=74, initial_indent=icon + " ", subsequent_indent="   "):
        print(line)
    print("")

if not entries:
    print("(no messages in session)")
PY
            2>/dev/null || echo "CWD: $project  Session: $id"
            ;;
    esac
}

view_subagent() {
    local file="$1"
    AGENT_FILE="$file" python3 <<'PY'
import json, os, sys, textwrap

path = os.environ["AGENT_FILE"]
WIDTH = 100
MAX_TOOL_LINES = 20

RESET="\033[0m"; BOLD="\033[1m"; DIM="\033[2m"
CYAN="\033[36m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; BLUE="\033[34m"

def hr(c="─"):
    print(f"{DIM}{c * WIDTH}{RESET}")

def header(label, color):
    hr()
    print(f"{color}{label}{RESET}")
    hr()

def wrap(text, indent=""):
    out = []
    for paragraph in text.split("\n\n"):
        for line in paragraph.split("\n"):
            if not line.strip():
                out.append("")
                continue
            avail = WIDTH - len(indent)
            if len(line) <= avail:
                out.append(indent + line)
            else:
                out.extend(textwrap.wrap(line, width=avail,
                                         initial_indent=indent,
                                         subsequent_indent=indent,
                                         break_long_words=False,
                                         break_on_hyphens=False))
        out.append("")
    return "\n".join(out).rstrip()

# Pass 1: collect tool results indexed by tool_call_id
tool_results = {}
entries = []
try:
    with open(path, "r", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
                t = d.get("type")
                if t == "toolResult":
                    msg = d.get("message", {})
                    tid = msg.get("toolCallId", "")
                    if tid:
                        tool_results[tid] = msg
                entries.append(d)
            except Exception:
                continue
except Exception as e:
    print(f"Error reading {path}: {e}", file=sys.stderr)
    sys.exit(1)

print(f"{BOLD}{BLUE}╔{'═' * (WIDTH - 2)}╗{RESET}")
print(f"{BOLD}{BLUE}║ Pi Subagent Conversation{' ' * (WIDTH - 27)}║{RESET}")
print(f"{BOLD}{BLUE}║ {DIM}{path[:WIDTH-4]:<{WIDTH-4}}{RESET}{BOLD}{BLUE} ║{RESET}")
print(f"{BOLD}{BLUE}╚{'═' * (WIDTH - 2)}╝{RESET}")
print()

# Pass 2: render
for d in entries:
    t = d.get("type")
    msg = d.get("message", {}) if isinstance(d.get("message"), dict) else {}
    role = msg.get("role")

    # User message
    if (t == "user") or (t == "message" and role == "user"):
        content = msg.get("content")
        text = ""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    text = c.get("text", "")
                    break
        if text.strip():
            header("👤 USER", BOLD + CYAN)
            print()
            print(wrap(text.strip()))
            print()
        continue

    # Assistant message
    if t == "assistant":
        content = msg.get("content", [])
        if not isinstance(content, list):
            continue
        # Collect parts
        parts = []
        for c in content:
            if not isinstance(c, dict):
                continue
            ct = c.get("type")
            if ct == "text":
                txt = c.get("text", "").strip()
                if txt:
                    parts.append(("text", txt))
            elif ct == "toolCall":
                parts.append(("tool", c))
        if not parts:
            continue
        header("🤖 ASSISTANT", BOLD + GREEN)
        print()
        for kind, payload in parts:
            if kind == "text":
                print(wrap(payload))
                print()
            elif kind == "tool":
                name = payload.get("name", "?")
                args = payload.get("arguments", {})
                args_str = json.dumps(args, ensure_ascii=False)
                if len(args_str) > WIDTH - 6:
                    args_str = args_str[:WIDTH - 9] + "..."
                print(f"  {YELLOW}▶ {name}{RESET} {DIM}{args_str}{RESET}")
                # Paired result
                tid = payload.get("id", "")
                result_msg = tool_results.get(tid)
                if result_msg:
                    rcontent = result_msg.get("content", [])
                    rtext = ""
                    for rc in rcontent:
                        if isinstance(rc, dict) and rc.get("type") == "text":
                            rtext = rc.get("text", "")
                            break
                    if rtext.strip():
                        is_err = result_msg.get("isError", False)
                        col = RED if is_err else DIM
                        rlines = rtext.split("\n")
                        truncated = False
                        if len(rlines) > MAX_TOOL_LINES:
                            rlines = rlines[:MAX_TOOL_LINES]
                            truncated = True
                        for ln in rlines:
                            if len(ln) > WIDTH - 6:
                                ln = ln[:WIDTH - 9] + "..."
                            print(f"    {col}└─ {ln}{RESET}")
                        if truncated:
                            print(f"    {col}└─ … (truncated){RESET}")
                print()
        continue
PY
}

case "${1:-}" in
    --list|--list-all)
        build_list 0 /dev/stdout
        exit 0
        ;;
    --preview)
        preview_item "${2:-}"
        exit 0
        ;;
    --view)
        view_subagent "${2:-}"
        exit 0
        ;;
    --delete)
        kind="${2:-}"
        target="${3:-}"
        [[ -n "$kind" && -n "$target" ]] || exit 1

        case "$kind" in
            session)
                item_desc="saved session file: $target"
                action=(rm -f "$target")
                ;;
            tmux)
                item_desc="tmux window: $target"
                action=(tmux kill-window -t "$target")
                ;;
            subagent)
                task_dir="$(dirname "$target")"
                item_desc="subagent task dir: $task_dir"
                action=(rm -rf "$task_dir")
                ;;
            *)
                exit 0
                ;;
        esac

        printf '\n\033[1;31mDelete %s?\033[0m\n' "$item_desc" >/dev/tty
        printf 'Press \033[1my\033[0m to confirm, any other key to cancel: ' >/dev/tty
        read -n 1 -r reply </dev/tty
        printf '\n' >/dev/tty

        if [[ "$reply" == "y" ]]; then
            "${action[@]}"
        fi
        exit 0
        ;;
esac

# ---------------------------------------------------------------------------
# Interactive picker
# ---------------------------------------------------------------------------

LIST_FILE="/tmp/pi-agents-list.$$"
trap 'rm -f "$LIST_FILE"' EXIT
build_list 24 "$LIST_FILE"

if [[ ! -s "$LIST_FILE" ]]; then
    echo "No pi agents found."
    exit 0
fi

selection="$(fzf \
    --no-tmux \
    < "$LIST_FILE" \
    --delimiter=$'\t' \
    --with-nth=2,3,4,5,6,8 \
    --height=100% \
    --border-label=' Pi Agents ' \
    --prompt='> ' \
    --header='enter: attach | ctrl-a: show all | ctrl-d: delete (confirm) | esc: cancel' \
    --reverse \
    --algo=v1 \
    --tiebreak=begin,length \
    --preview="$quoted_script_path --preview {}" \
    --preview-window=right:65%:wrap \
    --bind='tab:down,btab:up' \
    --bind="ctrl-a:reload($quoted_script_path --list)" \
    --bind="ctrl-d:execute($quoted_script_path --delete {1} {9})+reload($quoted_script_path --list)" \
    --bind='esc:abort' \
    --info=inline \
    --padding=1)" || true

[[ -n "${selection:-}" ]] || exit 0

kind=""; icon=""; project=""; id=""; label=""; status=""; epoch=""; mtime=""; target=""
IFS=$'\t' read -r kind icon project id label status epoch mtime target <<< "$selection"

# NOTE: this code runs in the script's top-level scope, not a function,
# so we cannot use `local`. With set -u, an unbound var crashes the script
# silently inside a tmux popup.
less_flags="-R"
session=""
window_pane=""
window=""
cwd=""

case "$kind" in
    subagent)
        # Open formatted conversation in less for scrollable readable view.
        # For running agents, jump to end (+G) so latest content is visible.
        [[ "$status" == "running" ]] && less_flags="-R +G"
        # Use printf %q to safely shell-quote $target (handles embedded single quotes)
        tmux new-window -n "pi-agent" "$quoted_script_path --view $(printf '%q' "$target") | less $less_flags"
        ;;
    tmux)
        session="${target%%:*}"
        window_pane="${target#*:}"
        window="${window_pane%%.*}"
        tmux switch-client -t "$session" 2>/dev/null || true
        tmux select-window -t "${session}:${window}" 2>/dev/null || true
        tmux select-pane -t "$target" 2>/dev/null || true
        ;;
    session)
        cwd="$(head -1 "$target" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("cwd","."))' 2>/dev/null || echo ".")"
        # Use printf %q to safely shell-quote $target (handles embedded single quotes)
        tmux new-window -n "pi-resume" -c "$cwd" "pi --session $(printf '%q' "$target")"
        ;;
esac
