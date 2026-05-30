# Long-term memory

Stable facts and preferences that should influence future pi sessions.

## User preferences

- Prefer concise, practical, evidence-based answers.
- Prefer small, targeted code changes.
- Loop me in before disruptive/destructive actions on shared resources
  (restarting a shared daemon, force-push, broad rewrites): explain the
  diagnosis and get a quick go-ahead first.
- Prefer fixing the root cause over a workaround when it's feasible.
- Distinguish observed facts from inference, and verify before asserting. When
  curating memory, the test for keeping something is "would this have prevented
  an error / footgun, or made a session easier?"

## Environment

- Primary shell: zsh.
- Primary editor: Neovim.
- Primary terminal: WezTerm.

## Operating lessons — consolidated 2026-05-29 (first memory review; week of 05-24)

Recurring, cross-cutting lessons from a week of heavy multi-session work (DePuy
CPQ build, the Context Mesh perf-PR campaign, pi-intercom fixes). Behavioral
rules first; the concrete infra footguns point at deeper notes lower in this
file. North star for these: what would have prevented the mistakes these
sessions actually made.

### Multi-session coordination (the #1 source of wasted effort this week)
- **Shared working trees are the norm here.** Many pi sessions edit the SAME
  checkout in `/Volumes/git/toolkit` and `/Users/davidroth/dotfiles`. `git add
  <file>` stages whatever is on disk, including other sessions' uncommitted
  hunks. Always `git add -p` to isolate your own changes, or use a dedicated
  `git worktree`. (Caught real cross-staging more than once.)
- **Re-verify git state on any resumed / long-lived session before acting on
  remembered state.** A resumed session's mental model can be many commits
  behind reality. The pi-intercom session sent FALSE "X is uncommitted / Y not
  built yet" warnings to peers from stale context, then had to retract. Run
  `git log --oneline -15`, `git status`, and `git reflog` before trusting what
  you "remember."
- **Status/handoff messages drafted mid-exploration overclaim after a pivot.**
  Sessions reported "touched module.py / endpoint returns 200" when the actual
  diff touched one FE file and the endpoint still 404'd. Before sending a
  status, read the actual `git diff` and describe what SHIPPED, not what you
  were attempting. (Extends the existing "we measured vs we suspect" note.)
- **Don't assume your PR branch HEAD is stable** — peers force-push / rewrite
  shared PR branches (PR #273 moved under multiple sessions). Re-fetch and
  coordinate over intercom before rebasing or force-pushing.
- **To capture what other sessions are doing, read their transcripts, not their
  self-reports.** Ground truth: `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`
  (session NAME lives in `session_info` records, last one wins; a
  `subagent-chat-XXXXXXXX` name suffix = last 8 chars of the file UUID). A
  session's self-narrated handoff had stale commit hashes; the transcript did
  not. Transcript-reading also reaches idle/non-responsive sessions that
  intercom can't.

### Verification discipline
- **For schema / DB / index-mutating changes, verify what actually got
  INSTALLED at runtime — not just "tests pass" + "endpoint is fast."** The CM
  perf campaign nearly shipped a "#863 indexes contribute" narrative that was
  false: a sibling PR's invalid `CREATE VECTOR INDEX ... WITH [...]` syntax
  threw first and the index-creation loop never ran. The speedup was 100% from
  other PRs. For index PRs, run `SHOW INDEXES` after restart; the failure was a
  single easily-missed WARNING line.
- **After resolving git conflicts, grep for leftover markers before
  continuing.** A stray `<<<<<<< HEAD` survived a multi-marker resolution and
  `git merge --continue` committed the broken file. Always run
  `grep -nE '^(<<<<<<<|=======|>>>>>>>)' <files>` before `--continue` / commit.

### pi tooling
- **A long-running broker/daemon does NOT pick up source edits.** The intercom
  broker ran 3.5 days on stale code after `broker/` was edited 9 commits later;
  asks routed to dead registry sockets. Restart the daemon after editing it (a
  machine restart also clears it). General rule for any tsx/node daemon loaded
  once at spawn. See the intercom sections below for addressing/reply details
  (short-id reply correlation was fixed in `replyResolvesWaiter`; full-id and
  exact-name addressing always worked).
- **When a long-running tool "breaks," check the RUNNING process against the
  on-disk code before debugging the code.** On 2026-05-29 the on-disk intercom
  code passed 79/79 tests while delivery was broken — the only fault was a
  9-commit-stale broker process. Compare process start time (`ps -o lstart`)
  against `git log` / file mtimes first; a 30-second check that avoids an hour
  of debugging code that's already correct.

## pi-intercom — addressing, lifecycle, broker, dispatcher

### Addressing a peer: what resolves, what fails
The broker resolves a target by **display name** or **session UUID**, with
behavior that changed across the @davidroth/pi-intercom Phase 1 patch
(commit `d797a8a` on dotfiles main, 2026-05-26):

- **Display name (unique)** — works in all broker versions. The human label
  before the parens in `intercom list` (e.g. `depuy-cpq toolkit app`,
  `subagent-chat-aacd6b27`).
- **Display name (multiple match)** — returns "Multiple sessions named X are
  connected. Use the session ID instead."
- **Full 36-char UUID** (`ae4de195-43b9-4b97-82ab-471e2ee31d6c`) — works in all
  versions.
- **Short/prefix UUID** (the 8-char form shown in parens, e.g. `ac0e3789`) —
  **pre-Phase-1 (≤2026-05-25): ALWAYS failed** with "Session not found"
  regardless of validity (the single biggest daily UX trap). **Post-Phase-1:**
  a *unique* prefix now works; an *ambiguous* prefix returns "Multiple sessions
  match ID prefix X. Use the full session ID instead."
- **Nonexistent id/name** — "Session not found" / "...not delivered: Session not found".

Phase 1 also added: the `send` writability gate, `socket.on("error")` registry
cleanup, and `session_left` ask fast-fail. (Separately, on 2026-05-29 the
*client-side* short-id reply-correlation bug was fixed via `replyResolvesWaiter`
— addressing by full id or exact name always worked; see daily 2026-05-29.)

**Duplicate display names** block by-name routing entirely (e.g. two
"DePuy Demo Seed (Twin)" after a fork): `to:"<name>"` errors with the
multiple-match message, and a prefix from `list` may not resolve either.
Workarounds: ask the peer to `/name` itself uniquely (`Twin-A`/`Twin-B`); get
its full UUID via `intercom status` from *its* session; or skip the
notification. Prefer unique session names from the start.

**Triage implications:**
- "Session not found" is a *broker-side lookup* failure, NOT a peer-liveness
  signal. If a short-ID send fails, retry the display name before concluding death.
- "Message sent" only proves the broker had a writable socket FD to push to — it
  does not prove the peer is alive (the broker's `send` doesn't gate on
  `socket.writable` in older versions) — but it's a much stronger liveness
  signal than the absence of a too-narrow `ps` match.

### Session identity is unstable: UUIDs cycle, display names drift
Neither identifier is a durable key:

- **UUIDs are re-minted on every `register`** — not just on broker restart but
  on *any* reconnect (network blip, broker socket hiccup, the pi process
  re-establishing its connection). The display name is preserved across all of
  these. (Consistent with reaper-plan §1: `register` mints a fresh UUID; the
  UUID is not a stable identity. A future broker could let clients re-claim a
  prior UUID via a stable token.)
- **Display names drift** when a session renames itself mid-life (e.g. broad
  scope `Depuy CV integration` → narrow `Fix CPQ hydration race`), so a name
  logged in an earlier turn can return "Session not found" later.

So: a short-UUID prefix logged in turn N may not resolve in turn N+5 (it
cycled), and a display name logged earlier may have changed. **Mitigations:**
- Refresh `intercom list` immediately before sending to any session after a
  multi-turn gap. Cheap.
- Prefer the display name over a logged UUID; if names collide, pull the UUID
  fresh from `list` right before sending — don't reuse an old prefix.
- Use a tolerant retry: try the last-known name, and on "Session not found"
  fall back to `intercom list` + match.
- Sessions that rename themselves should preserve discoverability — keep a
  stable prefix/suffix (`Depuy CV integration (race fix)`) or announce the
  rename on their next outbound.

(Discovered across 2026-05-24 → 05-26: by-name collisions blocking Twin
notifications; UUIDs changing ~3h apart and after the morning broker cutover
[`ac0e3789` → `eb661fc3` for `depuy-cpq fold-in: T1 tests`]; and a dispatcher
send to `Depuy CV integration` failing after it renamed to `Fix CPQ hydration race`.)

### Silence ≠ death; design liveness probes to demand a reply
A pi session does NOT auto-process inbound intercom messages — it queues them in
the TUI and waits for the user (or the agent's next tool-turn) to engage. A
fully-live session will sit on an inbox message indefinitely if it has no reason
to act.

- "Message sent" → peer almost certainly live.
- No reply within N minutes → peer almost certainly STILL alive. The 10-minute
  `intercom ask` timeout is the *broker's* wait limit, not a peer-death signal.
- A probe that says "no action needed / no reply required" is **self-defeating**:
  a live, attentive session correctly ignores it, so silence can't distinguish
  live-and-obedient from dead. If you want a reply as a signal, ASK for one
  explicitly: "If this reaches you, reply with one line stating what you're
  doing — I'm building a session map."

**Reaper reframe:** the truly-dead-but-registered socket population is much
smaller than first estimated. On a machine with ~22 live pi processes and ~76
broker fd endpoints, the gap is mostly per-session multi-FD usage (register +
tool channels + streams), not ~54 zombies. The underlying reaper-plan bugs are
real (no PID-based liveness sweep; `send` not gating on writability; misleading
addressing UX) but the "50+ zombies" urgency was overheated. (Discovered
2026-05-25: of ~25 pings, 5 real replies [watched panes], 17 "Message sent" +
silence [live, idle].)

### Send/reply reliability: narration vs. tool call, and reply routing
- **"Report back via intercom" often gets narrated, not invoked.** A briefed
  session may emit a natural-language "Verdict sent: APPROVE_WITH_NITS" in its
  pane without ever invoking the `intercom send` tool — the same failure shape as
  "I'll fix X" without running an edit. The dispatcher never receives it.
  Mitigations: brief the *literal tool call* ("your last action MUST be an
  `intercom send` tool invocation with this content"); verify via
  `intercom pending` / inbox and re-ping if the pane says "sent" but nothing
  arrived; or have review sessions encode the verdict in their display name so
  `intercom list` itself is the channel. (Discovered 2026-05-26, blind-review #1280.)
- **The dispatcher is NOT immune.** Under context pressure / many parallel
  threads, the dispatcher confabulated a subagent's A/B/C proposal *before*
  receiving it and presented it as the subagent's output (2026-05-27). Before
  presenting any subagent output, scan the actual conversation for the matching
  `📨 From …` inbound; if there isn't one, say "still in flight, no output yet"
  rather than fabricate. When unsure, run `intercom list` + check session state
  ([idle] vs [tool:intercom]) before claiming a session reported back.
- **`intercom reply` (no explicit `to:`) routes to the active/single pending
  ASK — not the last message you read.** Non-ask `send` messages don't establish
  a reply target, so a bare `reply` can land on a session whose ask preceded the
  recent inbound by turns. Safe pattern: use explicit `intercom send
  to:<display-name>` for reports; use `reply` only immediately after answering a
  specific `intercom ask`. (Discovered 2026-05-27: an ack for `Diagnose CM
  slowdown` got routed to `subagent-chat-c0553839` via `intercom reply`.)

### Caveat: this week's intercom observations predate the 2026-05-29 broker cutover
The broker that served all of 2026-05-24 → 29 started 2026-05-26 09:19 on commit
`d797a8a` (Phase-1) but was **9 commits behind HEAD** — it lacked the
stale-registration eviction (`a101838`), the PID reaper + backpressure
(`f2bb1f4`), and the reachability fixes (`3d0daba`). Implications:
- The registry stale-row bloat (~70 → 22 rows cleared instantly by the 2026-05-29
  restart) was real **this week**, but only because the running broker lacked
  eviction-on-reconnect + the reaper. Current code has both, so a broker on
  current code (or any restart/cutover) self-cleans. This does NOT contradict the
  "zombies overheated" reframe above — much of the raw FD count is legit
  multi-FD-per-session; the genuinely-stale rows that did exist are now handled
  structurally, so reaper urgency is *lower* going forward, not higher.
- Behavior notes in this section were observed against that specific build. Before
  treating any of them as a current bug, re-check against the running broker's
  actual code (its start time vs `git log`).

## pi / runtime / shell internals

### pi subagents: tool availability + when to fan out
- `Agent` with `isolated: true` → the subagent gets ONLY built-in tools
  (read, bash, write, edit). Non-isolated subagents inherit extension/MCP tools
  (intercom, slack, notion, web_search, …). So intercom is NOT available to an
  isolated subagent; plain file/repo work is.
- Background isolated subagents are reliable and fast for **parallel, verbatim,
  deterministic** work: e.g. 41 session transcripts → per-session snapshot notes
  across 6 batches finished in ~5 min. Give each a disjoint work-list + a fixed
  output path, and have it report what it wrote.
- Do NOT fan out judgment-heavy / global-coherence work (e.g. restructuring this
  memory file) — that's better done in-session with a verbatim script you can
  verify. Rule of thumb: delegate breadth, keep coherence.

### pi session transcripts (durable on-disk record)
- Path: `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl` (cwd encoded with
  `/`→`-`, wrapped in `--…--`). One JSONL per session; the UUID is in the
  filename and the first `session` record.
- Record types: `session` (carries `cwd`), `session_info` (carries `name`;
  renames append new ones, **last wins**), `message`
  (`{role, content:[{type: text|thinking|tool_use|tool_result, …}]}`),
  `model_change`, `custom`. A `subagent-chat-XXXXXXXX` display-name suffix = last
  8 chars of the file UUID.
- Reading transcripts is the **ground-truth** way to capture another session's
  state — more reliable than an intercom self-report (a 2026-05-29 handoff cited
  stale commit hashes the transcript didn't) and it reaches idle/unreachable
  sessions. To dump readable text, parse `message` records and render role +
  text/tool parts; the tail holds current state, the head the original goal.

### pi process detection — the binary is literally `pi`

The pi-coding-agent binary's argv[0] in `ps` output is simply `pi`,
not `pi-coding-agent` or `@earendil-works/...` or anything with the
package name. A `ps | grep` for those package-name patterns returns
zero hits even on a machine with 20+ live sessions. Use:

```bash
ps -axo pid,ppid,etime,command | awk '$4=="pi" || $4 ~ /\/pi$/'
# or, complementary signal:
tmux list-panes -a -F '#{pane_current_command}' | awk '$1=="node"' | wc -l
```

Discovered 2026-05-25 during the 70-session triage. I originally
claimed "1 live pi process / 70 zombies" based on the narrow
package-name grep; the real count was 22 live pi processes, matching
22 tmux panes running `node` (pi's runtime), and ~24 broker-
addressable sessions. The "broker is all zombies" framing was
substantially wrong, and the original recommendation to `kill 6039`
would have wiped out every live session on the machine. Always
sanity-check process counts with `tmux list-panes` and
broker-side ping success rates before recommending a broker restart.

### Agent SDK Python library `claude_agent_sdk` vs raw `anthropic`

Two patterns in DistylAI agents:
- **MCP-based** (CV's graph Q&A agent): uses `claude_agent_sdk.ClaudeSDKClient` with `mcp_servers={"context-objects": {...}, ...}` config. Tools come from MCP endpoints dynamically. Skills materialized from agent_repo file tree. `permission_mode="bypassPermissions"`, `max_turns` configurable. Used by CV's KGC dispatcher.
- **Bespoke handlers** (pre-`f631948ea` depuy-cpq agent): uses `anthropic.AsyncAnthropic` directly + `messages.create(tools=TOOL_SCHEMAS)`. Tools are Python handlers in a `HANDLERS: dict[str, ToolHandler]` registry. Custom tool wrapping. Used to be 19 tools; now (post-f631948ea) 3.

When extending agents, check which pattern they use; adding "MCP tools" to a bespoke-handler agent requires significant restructuring. Conversely, adding bespoke handlers to a ClaudeSDKClient agent isn't supported — you'd have to expose them via an in-process MCP server.

### uvicorn `--reload` mode: the spawn_main child is the real worker

  When uvicorn runs with `--reload` (toolkit-supervisor always does
  in local dev), `pgrep -f worker_entrypoint.*depuy-cpq` finds only
  the **parent watcher process**, whose `/proc/<pid>/status` stays
  frozen at startup baseline (~650 MB VmSize, ~125 MB RSS) forever,
  no matter how much load you throw at the app. The actual serving
  worker is a multiprocessing child whose cmdline contains
  `multiprocessing.spawn import spawn_main` and whose `PPid` is
  the watcher's PID.

  To find it inside the supervisor container:
  ```sh
  for pid in /proc/[0-9]*; do
    pid=$(basename "$pid"); [ -r "/proc/$pid/cmdline" ] || continue
    cmd=$(tr -d "\0" < /proc/$pid/cmdline 2>/dev/null)
    case "$cmd" in
      *spawn_main*)
        ppid=$(awk '/^PPid:/{print $2}' /proc/$pid/status)
        echo "PID=$pid PPid=$ppid"
        cat /proc/$pid/limits | grep -i 'address space'
        grep 'VmPeak\|VmHWM\|VmSize\|VmRSS' /proc/$pid/status
        ;;
    esac
  done
  ```
  Note: `pgrep` / `ps` are not in the supervisor image — must walk
  `/proc` by hand. The container also lacks `procps`.

  RLIMIT_AS does inherit cleanly from parent to spawn_main child
  (verified 2026-05-27: parent + child both showed 4 GiB after the
  config bump).

  Without this, debugging memory issues against the uvicorn worker
  looks like "memory is frozen, the rlimit fix didn't take" when
  in reality the wrong PID is being inspected. The brief in
  `/tmp/supervisor-worker-memory-fix-brief.md` had the standard
  `pgrep` recipe and would have produced misleading observations.

### Bash secret-redaction pitfall: `${VAR:+x}${VAR:-NO}` prints the value

The pattern `${VAR:+present (length ${#VAR})}${VAR:-NO}` looks like it should print "present (length N)" if VAR is set or "NO" if not. But the two expansions concatenate — when VAR IS set, the first emits "present (length N)" AND the second emits the actual value (the `:-` default doesn't trigger because VAR is set). Result: the secret value appears in the output between them.

**Safe patterns** for testing "is VAR set, without echoing the value":
```bash
# Pick one:
printf 'VAR: %s\n' "${VAR:+set (length ${#VAR})}${VAR:-unset}"   # WRONG — same bug
[ -n "${VAR:-}" ] && echo "VAR: set (length ${#VAR})" || echo "VAR: unset"   # right
echo "VAR: $([ -n "${VAR:-}" ] && echo "set (length ${#VAR})" || echo "unset")"   # right
test -n "${VAR:-}" && echo "set length=${#VAR}" || echo "unset"   # right
```

Or just always pipe through a length-only check:
```bash
docker exec <c> sh -c 'if [ -n "${OPENAI_API_KEY:-}" ]; then echo "set length=${#OPENAI_API_KEY}"; else echo "unset"; fi'
```

Discovered 2026-05-27 while probing CM container env. Accidentally printed full OPENAI_API_KEY value into a dispatcher pi conversation. Not externally leaked but a real footgun for any secret-probe shell.

## git, worktrees & PR mechanics

### "Structural-superset wins" merge resolution can silently undo cross-file surgery

When folding two long-lived branches together, the natural per-file heuristic
"take the structurally richer side" works fine *for that file in isolation*
but misses cross-file coupling. Specifically: if branch A made a coordinated
refactor that **deleted** code from file X and **added** a new file Y to
replace it, while branch B was simultaneously evolving file X into a richer
"superset" (without ever knowing about file Y), the merge resolver will
likely:

- Take B's version of X wholesale (it's the structural superset) →
  resurrects the code A deleted.
- Take A's new file Y verbatim (no conflict — B never touched it) →
  keeps the replacement.

Net result: **both halves of two incompatible designs survive**, with no
caller wiring file Y in anymore. File Y is now orphaned but `python -c
"import Y"`-clean, so it doesn't fail loudly. Tests that imported Y
directly still pass; tests that went through the factory in X fail in
ways that look like config-shape mismatches, masking the real "we kept
two designs" bug.

**Specific case (PR #1245, depuy-cpq, 2026-05-25, merge `687b0ace1`):**
- Branch A (bootstrap, commit `d59bcab1d`, 1h before merge): coordinated
  refactor that deleted the inline `class ContextMeshDataSource` stub
  from `data_source.py` and added a 750-LOC standalone
  `cm_data_source.py` + rewired the factory's `from ... import`.
- Branch B (cv-wiring): two days of CV plumbing on top of the *original*
  `data_source.py` with the inline stub intact. Never saw
  `cm_data_source.py`.
- Merge resolution: "take cv-wiring (structural superset)" for
  `data_source.py`. Resurrected the inline stub, dropped A's import-line
  surgery. `cm_data_source.py` survived unconflicted but orphaned.
- The merge commit message itself caught this as a known follow-up — but
  *after* resolving, not during. Cleanup took its own commit.

**Defensive checklist for merging two long-lived branches:**

1. Before resolving each file conflict, `git log -p <ancestor>..<branch>
   -- <file>` *both sides*. Look for **deletions** on the "smaller" side
   — those are often load-bearing for additions elsewhere in that
   branch's diff.
2. For any new file that exists on only one side, `rg <ClassName>` (or
   `<filename stem>`) across the post-merge tree to confirm at least one
   importer remains. Zero importers = silent orphan.
3. After resolving, before pushing, run the test suite on the merged
   tree. Don't assume "no conflict markers + lint passes" means the
   merge is semantically clean. Cross-file coupling lives below those
   signals.
4. When in doubt, run the side's *own* test suite against the merged
   tree — failures often point at exactly the cross-file invariants the
   merge broke.
5. If the merge agent flags a follow-up in the commit message ("X is
   now orphaned, decide later"), treat that as a yellow flag, not a
   green one: at minimum verify *why* it ended up orphaned before
   deciding delete vs. port. The provenance ("two ships passed in the
   night" vs. "deliberately abandoned design") changes the right
   answer.

### Branch-redundancy checks — SHA scan is not enough

When triaging "is this branch's work already merged into another
branch?", comparing commit SHAs or subject lines is unreliable
because cherry-picks produce different SHAs (and rebases / squashes
can change subject lines). Use tree-equivalence or patch-id instead:

```bash
# Are commits tree-identical (same final state)?
git rev-parse <sha>^{tree}             # → tree hash, compare across sides

# Same patch content even after rebase / merge?
git patch-id < <(git show <sha>)       # → stable across cherry-pick
git cherry <upstream> <branch>         # → "+" means not in upstream, "-" means in upstream by patch-id
```

Discovered 2026-05-25 during the 70-zombie-session triage: I claimed
`david/fix-exact-limit-pagination` had 3 net-new commits + 1
duplicate. Actually all 4 commits were tree-identical to the first 4
of PR #860 (cherry-picks). The branch was fully redundant and got
deleted instead of becoming a new PR. A `git rev-parse <sha>^{tree}`
or `git cherry origin/main david/fix-exact-limit-pagination`
comparison would have caught this at triage time.

Symptom of the gap: a triage report listing N net-new commits when
in fact zero are net-new because they were all cherry-picked
elsewhere with different SHAs. Mitigation: in any "is this worktree
salvageable?" report, run `git cherry` between the branch and its
likely-successor + report the patch-id mismatches, don't infer from
subject lines.

Also: same dispatch had a restatement bug — branch was shown with
`upstream=origin/...` in the survey but the handoff brief said
"upstream=NONE". Always re-quote the original survey fields verbatim
into briefs, don't paraphrase them.

### "What does this set of commits touch?" — per-commit, not cumulative

When you need the file list for a specific subset of commits (e.g.
"the 4 unique commits on branch X compared to branch Y"), do NOT use
`git diff --name-only Y..X`. That's a two-tip cumulative diff that
also surfaces files where Y and X happen to differ for unrelated
reasons (e.g. Y went forward in parallel, intermediate commits, etc.).

Use per-commit stats instead:
```bash
for sha in <sha1> <sha2> ...; do
  echo "=== $sha ==="
  git show --stat --format= $sha
done
# or, for a contiguous range with no merges:
git log --no-merges --stat <sha-oldest>^..<sha-newest> --format='%h %s'
```

Discovered 2026-05-25 during the same 70-zombie triage: I dispatched
a brief saying "the 4 onsite-bootstrap commits touch 3 files (loader
.py, ingest .py, runbook .md)" — actually all 4 commits only touch
`scripts/load_depuy_onsite_graph_to_cm.py`. The 3-file list came from
a cumulative diff between two diverging branch tips, not from the
commits themselves.

Companion lesson (subordinate of the SHA-vs-tree-hash note above):
when judging "is this commit redundant with one already on the target
branch?", a `git branch --contains <sha>` check is *coincidentally
correct* if and only if the commits in question touch disjoint files
from the prior cherry-picks. That's a fragile floor. Default to
`git cherry` / `git patch-id --stable` instead, and treat the
disjoint-files observation as a sanity-check rather than the primary
test.

### "PR merged → worktree safe to remove" needs a usage guard

The bare criterion "PR merged → worktree safe to remove" is correct
in the steady state — a session that has finished pushing to its
branch and seen it merged generally has no reason to keep pinning the
worktree. The criterion FAILS when a session is *currently using*
the worktree for ongoing work that survived the merge: benchmarks
of the merged path, post-merge stress testing, diffing the merged
version against alternatives, or using it as a working dir whose
source files have nothing to do with the merged branch's diff.

Guard to add before any "PR-merged → remove" sweep:

Always check before `git worktree remove`:
```bash
# Any process with cwd here?
lsof +D <worktree-path> 2>/dev/null | head
# Any tmux pane with cwd here?
tmux list-panes -a -F '#{pane_current_path}' | grep -F "<worktree-path>"
# Any pi session registered here?
intercom list | grep -F "<worktree-path>"
```

Discovered 2026-05-25 during the 70-session triage: I removed
`/Volumes/git/context-mesh-bulk-ingest` (PR #859 merged → "definitively
done"), and the `depuy-cpq toolkit app` session reported it had been
"running a perf benchmark of #859's bulk-ingest path" in that dir.
Post-hoc investigation showed: the benchmark actually targets cloud
(vanilla.dev) and runs out of a *different* worktree
(`/Volumes/git/context-views-depuy-readable`); the deleted worktree
held only already-committed + already-pushed content (all 3 commits
were in main via the squash-merge); no untracked artifacts were on
it. So that specific removal turned out fine — but only by luck.
Branch tip `b664a1d0` was still in the object DB as a dangling
commit, so `git branch <name> <sha> && git worktree add ...` would
have reconstructed it if needed.

Same pattern same day also removed `toolkit-pa-voice-tests`
(PR #740 merged) and `context-views-list-tickets` (PR #259 merged)
without the same check — those happened to not have live sessions
attached, but that was luck, not rigor.

Companion rule: when the user pre-approves a batch of removals,
**re-verify each item's "no live attachment" status immediately
before the destructive op**, not just at proposal time. Sessions can
become attached between proposal and execution. The check is cheap.

### `gh pr view` PR-object cache lags fresh pushes by seconds

For fresh-push verification, `gh pr view <num> --json headRefOid` can
return the *pre-push* SHA for a few seconds after a successful push.
The git refs REST endpoint is consistent immediately:

```bash
# Lagging (PR-object cache):
gh pr view 273 -R <org>/<repo> --json headRefOid -q .headRefOid

# Immediate (git refs):
gh api repos/<org>/<repo>/git/refs/heads/<branch> -q .object.sha
# or:
gh api repos/<org>/<repo>/branches/<branch> -q .commit.sha
```

For automated verification scripts, prefer the refs API. For
human-readable PR state, sleep+retry on `gh pr view` is fine but be
aware of the staleness window.

Observed twice 2026-05-25 during the loader-fixes-port cherry-pick
push to PR #273. Push completed; refs API returned the new SHA
instantly; `gh pr view` returned the old SHA for ~5s before
catching up.

### Never classify uncommitted work by path/filename — read the diff

Uncommitted-files audits during a worktree triage MUST inspect the
actual diff content, not bucket by path. Filenames like
`config/settings-dev.toml` or `deployments/vanilla-dev.yaml` look
like "local dev tweaks" by convention but in practice often hold:

- substantive bug fixes layered into module code (e.g. a 16-line
  `_request_bearer_token` helper in `server/module.py` that ignores
  the Toolkit mock-auth placeholder so requests fall back to CV's
  service API key — looks like config-adjacent but is a real fix)
- production deployment tuning with runbook commentary (memory
  limits, concurrency caps, post-PR follow-ups)
- environment-specific configuration overrides that local dev
  literally cannot run without (agent repo IDs after a CM reseed)
- safety snapshots (`.bak-before-X` files) that the user
  deliberately created and would be unhappy to lose

Practical rule for a triage report:
- For each `M` file: `git diff <file> | wc -l` → if > 5 lines, dump
  a head -40 into the report or at minimum mention "non-trivial,
  inspect before any cleanup."
- For each `??` file: `head -40 <file>` and *show the user what it
  is*. Untracked tests and `.bak` snapshots are not noise.
- For deployment/yaml/runbook .md files: skim for runbook-style
  commentary. A diff comment that explains *why* a change exists
  is a strong signal it's not just dev-machine drift.

Discovered 2026-05-25: I dismissed 4 uncommitted files in
`/Volumes/git/context-views` as "local-config-ish | local dev
tweaks". Reading the actual diffs found a mock-auth bug fix
(`server/module.py`), production OOM-fix deployment tuning
(`vanilla-dev.yaml`), real CM-reseed overrides (`settings-dev.toml`)
plus an explicit safety snapshot. The "Investigate postGraphChat
500" session is the likely owner of part of this.

### Git primary clone hosts side-effects from all its secondary worktrees

In a multi-worktree git layout (one primary clone + N secondary
worktrees via `git worktree add`), the **primary clone's working
tree** is a shared dumping ground for any session that needs to
write into the primary's filesystem location, regardless of which
branch/worktree they're conceptually working on. Common reasons a
session writes to the primary clone instead of its own worktree:

- Mounting that path into a Docker dev container (the container
  was set up with the primary clone path before secondary worktrees
  existed; only the primary clone's path gets hot-reloads).
- Local config / secrets files that need to be in the primary clone
  for tool defaults.
- Ad-hoc edits the session forgot to redirect into their secondary
  worktree.

Consequence for triage: uncommitted state in the primary clone is
NOT automatically attributable to "the session whose registered cwd
is here". It can come from any session. To identify the real owner:

- Read the diff content and look for signature names/naming
  conventions ("depuy-mini-default" → Twin, etc.).
- Check file mtimes against known active-session windows.
- Look for a sibling worktree dedicated to the same campaign (the
  primary clone often carries the deployment/config piece while
  the code piece lives in a focused secondary worktree).
- Just ask via intercom — most sessions know if it's theirs.

Discovered 2026-05-25 during the 70-session triage. The 4
uncommitted files in `/Volumes/git/context-views` (the primary
clone) belonged to at least 3 different sessions:
- `server/module.py` → `Debug CV 503` (PR #278 dev-mount mirror)
- `config/settings-dev.toml` → multiple sessions edited it for
  local CM-reseed agent_repo_ids overrides
- `deployments/vanilla-dev.yaml` → `DePuy Demo Seed (Twin)`
  (thematically paired with David's PR #277 kg_ingest backoff;
  parked locally pre-deploy-validation; not yet PR'd)
- `config/secrets-dev.toml.bak-before-depuy-mini-default` → Twin
  (matches their "depuy-mini-default" naming convention)

The "registered cwd" field in `intercom list` is misleading for
primary clones — it tells you where a session was launched, not
where it does its work.

### `git checkout --theirs <file>` during a cherry-pick silently drops auto-merged content

During a cherry-pick conflict, the temptation is `git checkout --theirs <file>`
when you've decided "the picked commit's intent wins for this file". This is
**not** equivalent to "accept the picked side at each conflict hunk". `--theirs`
replaces the working-tree file with the **complete file from the picked
commit's tree**, throwing away any auto-merged hunks outside the conflict
region.

This is safe **only when** the file in HEAD has zero post-merge-base edits
outside the conflicted region. If HEAD has additions/improvements in
non-conflicted regions, `--theirs` silently drops them.

**Pattern that bites:**
- Long-lived branches A and B, both share an ancestor.
- A made substantive non-conflicting improvements to `foo.py` (new functions,
  new dict entries, comprehensions).
- B makes a small targeted change to `foo.py` — say, a doc-comment swap.
- Cherry-picking B's commit onto A. Conflict marker appears only on the
  doc-comment hunk (the rest auto-merges, keeping A's improvements).
- `git checkout --theirs foo.py` replaces the auto-merged file with B's
  view of foo.py, which **doesn't have A's improvements** because B's
  branch never had them. Net result: A's improvements silently disappear.
- Tests may or may not catch it depending on coverage. Pyright/ruff/lint
  rarely catch it (the file is still syntactically valid).

**Right way to resolve "take the picked side at this conflict":**
1. Open the file in an editor.
2. For each `<<<<<<< / ||||||| / ======= / >>>>>>>` block, delete the HEAD
   side + base side, keep the theirs side. Leave all auto-merged regions
   untouched.
3. `git add <file>`.

Safer alternatives when only one hunk conflicts:
- `git checkout --conflict=diff3 <file>` then hand-edit the markers (merge
  base visible, so you see what would be lost).
- `git mergetool` for an interactive 3-way view.
- For a one-line conflict, just `git diff <file>` after the failed pick,
  edit the `<<<<<<<` block directly, `git add`, then `--continue`.

**Diagnosis checklist when a cherry-pick lands without conflicts but tests
regress:**
- Did anyone do `git checkout --theirs` or `--ours` on a file with non-conflicted
  divergence? Run `git diff <pre-cherry-pick-commit> -- <file>` to see what
  was actually changed and compare with the picked commit's intended diff
  (`git show <picked-commit> -- <file>`). If they don't roughly match in
  scope, you have a `--theirs`/`--ours` regression.

**Cheap pre-flight check** before using `--theirs`:
```bash
# Is HEAD's view of the file diverged from the cherry-pick base outside the
# conflicted regions? If yes, --theirs is unsafe.
git diff <picked-commit>^ HEAD -- <file>  # ours-side drift
git diff <picked-commit>^ <picked-commit> -- <file>  # what the pick actually changes
```
If the ours-side drift extends beyond what the pick touches, hand-resolve
the conflict instead.

Discovered 2026-05-25 during PR #1245 cv-wiring → bootstrap consolidation
(toolkit). `--theirs` on `mocks.py` dropped bootstrap's `d59bcab1d`-era
GOVERNANCE_BY_CONTRACT / GENERATE_PREVIEWS comprehensions + ~100 lines of
contract entries; caught by `pytest --collect-only` failing with 13
failures before push, fixed by restoring `mocks.py` from HEAD~1 and
surgically reapplying the 6-line doc-comment swap the pick actually
intended. Safe on the 8 other files I `--theirs`'d in the same campaign
because bootstrap had zero post-merge edits to them. The asymmetry is
exactly the failure mode to watch for.

### Git author email

When making commits on the user's behalf, the correct git author is:

```
git -c user.name="David Roth" -c user.email="david.roth@distyl.ai" commit ...
```

NOT `david@distyl.ai` (that was a guess I used in commits up through PR #1286 on
2026-05-26 before being corrected). Use `david.roth@distyl.ai`.

If a project / worktree has a configured git identity already, prefer that
over inline -c overrides. Inline -c is the right move when the worktree
isn't configured for the user.

### Shallow clones cause phantom "AA" conflicts during rebase

When rebasing in a worktree backed by a shallow clone, git can produce
27+ "both-added" (`AA`) phantom conflicts on a rebase that should be
clean. Root cause: without parent history visible, git can't do a real
3-way merge, so every file appears as "both-added" instead of being
recognized as having a common ancestor on both branches.

Diagnostic:

```bash
git rev-parse --is-shallow-repository   # returns 'true' if shallow
git rev-list --count HEAD               # if it returns a tiny number
                                        # like 2 when you expect 100s,
                                        # you're shallow
```

Fix:

```bash
git fetch --unshallow origin   # may auth-fail at the very end but
                                # the data still lands; merge-base
                                # then resolves correctly
```

Worktrees that share a `.git` are all shallow together (the shallowness
lives on the primary clone's `.git/shallow` file). So if one worktree
on `/Volumes/git/toolkit` is shallow, they all are. Unshallow once
in any of them and the rest resolve.

Discovered 2026-05-26 by the fold-in session when rebasing #1285 onto
`gautham/depuy-cpq-cm`'s new `f631948ea` tip — they hit 27 phantom AA
conflicts, traced it to shallow state, ran `git fetch --unshallow`,
and the rebase then resolved cleanly to merge-base `07676fa9c` with
just 3 real file conflicts.

If a session reports an unexpectedly large or weird conflict set
during a rebase, this is the first diagnostic to run before assuming
the conflict shape is real.

### GitHub branch rename closes the open PR

`gh api -X POST /repos/{owner}/{repo}/branches/{old}/rename -f new_name=...`
renames at the git level (old ref deleted, new ref created at the same SHA),
but GitHub treats the disappearance of the old head ref as a delete and
**auto-closes any open PR that referenced it**. The PR's `head.ref` stays
pinned to the old (now-gone) name; you can't re-point it via the API.

Recovery options:
1. Open a fresh PR from the renamed branch (clean, but orphans the old PR
   number — reference it in the new body for continuity).
2. Re-create the old branch name pointing at the same SHA, then re-open
   the PR (preserves PR number, but you now have two branches pointing
   at the same commits — confusing).

Default to (1). Note the PR-number bump in any downstream comms.

If you need to signal a branch's intent (e.g. "prep, not feature") and a
PR is already open, prefer **editing the PR title + description** over
renaming the branch. Branch rename should be a pre-PR or stale-branch
operation.

Discovered 2026-05-27 doing the depuy-cpq-graph-query-prep rename — PR
#1308 closed silently, had to re-open as #1309.

### Cherry-pick discipline: hooks-after-early-returns bug class

When cherry-picking React components into a host page (`WorkspacePage`, `QueuePage`, etc.) that has existing early-return guards (loading / error / empty states), if the cherry-picked code adds a new hook call AFTER one of those guards, the host page violates Rules of Hooks. Symptom: "Rendered more hooks than during the previous render" at runtime. `pnpm build` + `pnpm test` + `pnpm typecheck` all pass — only browser render-cycle catches it.

Example (caused by depuy-cpq Customer card PR #1317 + cherry-pick onto a WorkspacePage already 14 hooks in):
```javascript
export function WorkspacePage() {
  // ... 14 existing hooks ...
  if (w.isLoading) return <Loading/>;   // pre-existing early return
  if (w.isError) return <Error/>;
  
  const d = w.data;
  // ❌ NEW HOOK after conditional return:
  const customerIdentity = useCustomerByName(d.customerName);
  // ... render JSX using customerIdentity ...
}
```

Fix: move the hook BEFORE the early returns; handle the "data not ready yet" case via optional chaining:
```javascript
export function WorkspacePage() {
  // ... 14 existing hooks ...
  // ✓ HOOK at top, called every render:
  const customerIdentity = useCustomerByName(w.data?.customerName ?? '');
  
  if (w.isLoading) return <Loading/>;
  if (w.isError) return <Error/>;
  
  const d = w.data;
  // ... render JSX using customerIdentity ...
}
```

The hook handles the lifecycle when name changes from `''` (during loading) to the real name (when w.data resolves). React Query / useQuery-backed hooks recompute their fetch on dep change.

**For future cherry-picks of components that introduce a NEW hook call to a host page**: ALWAYS check that the new hook is invoked at the TOP of the host component, before any conditional returns. The PR's own diff looks innocent in isolation (it's an obviously-correct one-line insertion); the violation only emerges in the cherry-picked context where the host page already has early returns.

Pattern also applies to other host pages: `QueuePage`, `TodayPage`, etc.

Discovered 2026-05-27 by browser-side React error after cherry-picking PR #1317.

### Don't infer route-data-flow from file names — read the flow

Dispatcher-level architectural guidance based on directory/file
names is unreliable. Twice in two days I made the same mistake:

1. **2026-05-25 CV unmount**: I scoped the proper CV-side fix
   assuming an iframe-shim architecture. A Plan agent reading the
   actual code found there is no iframe shim — CV renders as a
   normal `<Suspense>`-wrapped React component in a single shared
   `<BrowserRouter>`. My commit message on the workaround landed
   on PR #1245 still containing the false "iframe shim" claim
   until corrected.

2. **2026-05-26 CV data fold-in shape**: I told a fold-in session
   the CV seam should be "parallel to Gautham's `cm/` package",
   inferring that `cm/` was the graph-read substrate based on the
   directory name. A cv-fold-survey session reading the actual
   route flow found Gautham's `cm/` is **file-store / parquet-
   cache / auth-token** infrastructure, NOT graph reads. The actual
   route-read path is `route → db.repo → pcl_state`. The correct
   CV seam is **above `db.repo` in the route-read path**, not
   alongside `cm/`.

Workflow rule: when a session asks me "where should X slot into
codebase Y?", and I haven't read codebase Y's actual flow
end-to-end:
1. Either pull the seam-question to a session that has read it
   (the cv-fold-survey pattern — dispatch a read-only survey
   session, get a code-grounded answer, route it back).
2. Or explicitly preface my answer with "I haven't read this
   codebase's flow — verify by reading X/Y/Z before acting on my
   guess."
3. Never present an inferred-from-naming architectural claim with
   the same confidence as a session that has actually read the
   code.

Companion rule for any future "where should this PR fit?" question:
the session that did the read-only survey of the target codebase is
the source of truth for the seam shape. Their answer overrides any
naming-based intuition from sessions (including the dispatcher)
that haven't.

## process & collaboration discipline

### GitHub / forum communication preference

Do not post in GitHub forums (PR review threads, issue comments, discussions,
review-thread replies, "resolve conversation" actions, etc.) on the user's
behalf unless explicitly asked to do so in that turn.

This includes:
- Replying to PR review comments (e.g. from CodeRabbit, claude-review, or
  human reviewers like Clay)
- Posting "addressed in commit X" or similar fix-up notes
- Resolving / dismissing review threads
- Posting on issues, discussions, or GitHub team forums
- `@coderabbitai resume` / `@coderabbitai review` style bot triggers — also
  off limits unless asked

Acceptable without being asked:
- Pushing commits / opening branches (visible evidence of fixes is fine)
- Running `gh pr view`, reading comments, summarizing them back to the user
- Editing PR descriptions only if user asked me to manage the PR description
- Operations on the user's own local files / commits

Default behavior when a comment needs a reply: surface the comment back to
the user, propose what I'd say, but let them post (or ask me to post).

Established 2026-05-23 after I posted `@coderabbitai resume` on PR
DistylAI/toolkit#1245 without being asked.

### PR-campaign hygiene: "we measured" vs "we suspect"

When shipping multi-PR fixes under time pressure (esp. with parallel
subagents), the bias-toward-action that gets code right also tends to
over-claim in PR descriptions. Concrete claims like "720× amplification"
or "fully hung" get written in the heat of the moment as if observed
when they were actually inferred / arithmeticked / extrapolated.

**Pattern that worked** (depuy-cpq / context-mesh #860 / context-views #275, 2026-05-24):

1. Ship code aggressively (parallel subagents in isolated worktrees,
   adversarial blind review for each PR).
2. **Post-compaction**, do a deliberate "sanity sweep" turn:
   - Audit each empirical-sounding claim in PR descriptions.
   - Distinguish observed (curl output, kubectl, log line, build
     artifact) from inferred (architectural reasoning) from
     extrapolated (small-graph number scaled to big-graph).
   - Check with peer agents — they'll tell you when their direct
     observations differ from your assumed-shared narrative.
   - Verify "incidentally fixes latent bug X" claims against the actual
     diff vs. main. Reviewer-subagents catch code bugs but rarely
     catch description-overclaim.
3. If a claim is inferential, either MEASURE it (took 10 min: local CM
   probe → measured 7× edge amplification → honest number for the PR)
   or downgrade the language ("suspected", "estimated", "extrapolating").
4. If a whole PR's load-bearing justification fails the audit, CLOSE
   IT — don't ship correctness-positive code that defends zero live
   code paths. Open a tracking issue instead.

**What the adversarial review missed**: reviewer subagents catch logic
bugs in the diff but rarely catch "is the description verifiable?".
Next time, explicit reviewer prompt: "is each empirical claim in the
description verifiable from the diff alone, or does it require external
observation that we haven't done?"

**Specific overclaims to watch for**:
- "Fully hung" when the truth is "exceeds gateway timeout, server still processing"
- "X× amplification" without showing the byte counts
- "Fixes a latent bug" without diffing against main to verify the bug
  exists in main
- "Sibling PR addresses Y" when neither helper has a load-bearing caller
- "User-facing impact" without having actually run the UI against the
  failure scenario

### Partial reverts of workarounds are risky without bug repro

When proposing to "revert the workaround half of a commit but keep the
'real fix' half", verify with the original author (or by re-running
the repro) that the "real fix" half ACTUALLY fixes the underlying
bug on its own. A commit can look like "two independent changes" in
the diff but the bug it addresses can only be fixed by both halves
in concert. Reverting just one half then leaves the bug reintroduced
while the user assumes "we kept the fix".

Discovered 2026-05-25 on PR #1245's AppLayout.tsx workaround
(commit 989969623). The diff had two parts: (1) a generic
ShellSidebar anchor-click → useNavigate intercept, (2) a
`/context-views` hard-nav escape via window.location.assign. I
proposed partial-revert as an option ("keep the legit generic
intercept, drop the hard-nav workaround"). The author had actually
tested both halves and confirmed only the hard-nav escape fixes the
stale-mounted CV UI bug. The generic intercept alone is a no-op for
the failure mode. Partial revert would silently regress the demo
while creating the appearance of preserving the fix.

Rule: before proposing partial-revert of a workaround, either (a)
get the original author to confirm which sub-change actually fixes
which sub-bug, or (b) re-run the failing scenario yourself. Don't
infer "this looks like architecture, this looks like a hack, keep
the first one" from the diff alone.

### Survey prior-art with the bug-hitter BEFORE dispatching a fix plan

When scoping a fix for a bug, the most valuable input is "what
attempts have already been tried, by whom, with what result". This
trumps architectural reasoning from code-reading alone, because the
person who originally hit the bug has runtime observations that
constrain the hypothesis space.

Workflow rule: before dispatching a Plan or implementation agent to
fix a bug, FIRST get prior-art from the session/person who hit it:
1. What was the exact observed symptom (vs. the inferred mechanism)?
2. What attempts have they tried? Which fixed it, which didn't?
3. What signals did they NOT see (e.g. "I did NOT observe X")?

Feed all of that to the Plan agent as "evidence to constrain the
hypothesis space", not as background reading. The agent should
explicitly reconcile its recommendation against the failed attempts.

Discovered 2026-05-25 on the CV history-to-React-Router fix.
Sequence of events:

1. "Debug app visibility" session hit the bug in the depuy-cpq demo:
   clicking shell sidebar to leave /context-views, the outer URL
   changed but the CV UI stayed mounted/rendered.
2. They tried 4 fixes locally: synthetic PopStateEvent (no fix);
   full useNavigate/useLocation conversion of CV (no fix); generic
   shell anchor-intercept + navigate (no fix); only
   window.location.assign hard-nav escape worked.
3. They wrote up the workaround commit (since rewritten on PR #1245
   with corrected provenance) and dropped a note describing the
   intent.
4. I dispatched a Plan agent to scope the "proper fix" based on
   reading the code, WITHOUT first asking Debug app visibility what
   they'd already tried.
5. Plan agent hypothesized a L263 race (CV's effect rewriting URL
   back) and recommended converting to useNavigate/useLocation —
   essentially attempt #2 from Debug app visibility's list, which
   they had already verified did NOT fix the bug.
6. I dispatched an implementation session to do the recommended
   fix. They were about to start editing.
7. Debug app visibility responded to a separate ping with their
   prior-attempt history; the contradiction caught the
   implementation session before any edits.

If the prior-art survey had come BEFORE the Plan dispatch, the plan
would've explicitly addressed "why didn't useNavigate conversion fix
this? what's the actual mechanism?" and the recommendation would
not have been Option C alone. The plan agent's own §3 open question
1 ("verify the hypothesis at runtime before committing") was a
hedge, but a hedge isn't a substitute for incorporating known
runtime evidence.

Symptom-as-described matters. Debug app visibility's exact words:
> "After failed attempts, clicking DePuy from CV changed the
> address bar to /depuy-cpq, but the Context Views UI stayed
> mounted/rendered. ... I did NOT observe the URL being rewritten
> back to /context-views/..."

That "outer URL changes, rendered UI stays" — vs. the plan's
hypothesized "URL gets rewritten back" — is a meaningfully different
mechanism. Mount/unmount problem (probably in the shell's dynamic-
app lazy() / portal / outlet wiring) rather than a URL desync.

Rule: paraphrase every bug report into "what symptom was observed"
+ "what mechanisms it is therefore NOT" before generating a
hypothesis. The negative-evidence half is half the information.

## Memory curation (how to maintain this file)

First consolidated 2026-05-29. Guidelines for keeping this file useful:

- **Three tiers.** `daily/` is the append-only log (timestamped, may contain
  duplicates + later corrections); `SCRATCHPAD.md` is for uncertain/temporary
  reminders; this file (`MEMORY.md`) is durable long-term memory.
- **What earns a spot here:** the north-star test — *would this have prevented an
  error/footgun, or made a future session easier?* Keep behavioral rules,
  recurring infra footguns, stable preferences, and hard-won mental models.
  Leave ephemera (specific graph IDs, tokens, one-off commit hashes, in-flight
  task state) in `daily/`.
- **Format:** add new notes as `### Title` under the correct thematic `## `
  section. Do NOT append raw `- ##` / `- - ##` bullet-headers — that
  inconsistency is exactly what forced the 2026-05-29 cleanup. Bump any in-note
  subsections to `####`. The `memory` tool's `append` (pi-memory ≥0.2.0)
  supports `section="<## heading>"` to place a well-formed block there
  automatically, and `read` supports the same for section-scoped reads — prefer
  those over a blind EOF append.
- **Promoting from daily:** reconcile first — daily logs accumulate corrections
  and the **last correction wins** (e.g. the Workspace-404 fix was re-stated ~4×
  on 2026-05-24; only the final FE-only version is true). Never promote an
  early/retracted claim.
- **Periodically consolidate:** dedupe true duplicates, co-locate by theme, and
  prose-merge clusters that have grown to many overlapping notes (the
  pi-intercom cluster went 10 → 4 on 2026-05-29). Keep a dated backup before any
  big rewrite and content-diff to prove no facts were lost.
- **Never store secrets/tokens.**
