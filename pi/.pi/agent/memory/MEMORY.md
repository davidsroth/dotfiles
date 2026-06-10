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

### Two systematic biases David has had to correct me on (watch for both)
1. **Overconfidence in claims** — sliding from "built it / a script passed" to "strong / de-risked / done." Counter: state what's actually verified vs. inferred; downgrade confidence words until evidence supports them.
2. **Over-conservatism in scope — i.e. systematically choosing the EASY problem over the NORTH STAR.** This is the one to watch hardest. The failure mode is subtle: when I hit a hard/ambitious path I drift to a tractable SUBSTITUTE for it and then dress the scope-shrink up as "calibration / prudence / the bounded move." Symptom verbs: narrowing, shelving, "setting aside," "folding in lightly," "for now," "as a stretch/fallback," reaching for the convenient mechanism (e.g. a local file instead of the real end-to-end loop; reusing the inherited shape to "avoid a regen"; "probe then maybe translate" instead of the real rework). David's actual brief is almost always "build the most impressive thing we can do *well* in the time," and his read of past failures (e.g. DePuy) is "we should have invested MORE ahead of time," not "cut to be safe."
   - **Active self-catch (run this checkpoint, don't wait to be caught):** before committing to an approach, ask *"Am I choosing this because it's RIGHT/on-vision, or because it's EASIER? Is this the north star, or a tractable stand-in I'm rationalizing?"* If the ambitious version is being demoted to "stretch/fallback," that's the tell — flip it back to the target and let David dial back, rather than pre-shrinking. Name the bigger build explicitly.
   - **Real ≠ unbounded:** the counter to settling is NOT gold-plating everything. Distinguish *settling* (pre-shrinking something on-stage / on-vision) from *focus* (declining to gold-plate invisible plumbing). Be ambitious on what's load-bearing for the vision; be surgical on what isn't.
   - Honesty bar still holds (don't *ship/show* half-baked things) — but that argues for building more sooner, not scoping down.
These are distinct: be bold about SCOPE/ambition while staying calibrated/humble about CLAIMS.


## Environment

- Primary shell: zsh.
- Primary editor: Neovim.
- Primary terminal: WezTerm.

## Operating lessons

Recurring, cross-cutting lessons from heavy multi-session work (multi-PR build
campaigns, backend perf work, pi-intercom fixes). Behavioral rules first; the
concrete infra footguns point at deeper notes lower in this file. North star:
what would have prevented the mistakes these sessions actually made.

### Multi-session coordination (a top source of wasted effort)
- **Shared working trees can be the norm.** Multiple pi sessions may edit the
  SAME checkout. `git add <file>` stages whatever is on disk, including other
  sessions' uncommitted hunks. Always `git add -p` to isolate your own changes,
  or use a dedicated `git worktree`. (Caught real cross-staging more than once.)
- **Re-verify git state on any resumed / long-lived session before acting on
  remembered state.** A resumed session's mental model can be many commits
  behind reality. A session once sent FALSE "X is uncommitted / Y not
  built yet" warnings to peers from stale context, then had to retract. Run
  `git log --oneline -15`, `git status`, and `git reflog` before trusting what
  you "remember."
- **Status/handoff messages drafted mid-exploration overclaim after a pivot.**
  Sessions reported "touched module.py / endpoint returns 200" when the actual
  diff touched one FE file and the endpoint still 404'd. Before sending a
  status, read the actual `git diff` and describe what SHIPPED, not what you
  were attempting. (Extends the existing "we measured vs we suspect" note.)
- **Don't assume your PR branch HEAD is stable** — peers force-push / rewrite
  shared PR branches (a shared PR branch once moved under multiple sessions).
  Re-fetch and coordinate over intercom before rebasing or force-pushing.
- **To capture what other sessions are doing, read their transcripts, not their
  self-reports** — transcripts reach idle/unreachable sessions and don't drift
  like self-narrated handoffs (which have cited stale commit hashes). See "pi
  session transcripts" under runtime internals for the path + record format.

### Verification discipline
- **For schema / DB / index-mutating changes, verify what actually got
  INSTALLED at runtime — not just "tests pass" + "endpoint is fast."** A perf
  campaign once nearly shipped an "indexes contribute to the speedup" narrative
  that was false: a sibling PR's invalid `CREATE VECTOR INDEX ... WITH [...]`
  syntax threw first and the index-creation loop never ran. The speedup was 100%
  from other PRs. For index PRs, verify the indexes actually exist after restart
  (e.g. `SHOW INDEXES`); the failure was a single easily-missed WARNING line.
- **After resolving git conflicts, grep for leftover markers before
  continuing.** A stray `<<<<<<< HEAD` survived a multi-marker resolution and
  `git merge --continue` committed the broken file. Always run
  `grep -nE '^(<<<<<<<|=======|>>>>>>>)' <files>` before `--continue` / commit.

### pi tooling
- **A long-running broker/daemon does NOT pick up source edits.** The intercom
  broker once ran 3.5 days on stale code after its source was edited 9 commits
  later; asks routed to dead registry sockets. Restart the daemon after editing
  it (a machine restart also clears it). General rule for any tsx/node daemon
  loaded once at spawn.
- **When a long-running tool "breaks," check the RUNNING process against the
  on-disk code before debugging the code.** Once, the on-disk intercom code
  passed its full test suite while delivery was broken — the only fault was a
  many-commits-stale broker process. Compare process start time (`ps -o
  lstart`) against `git log` / file mtimes first; a 30-second check that avoids
  an hour of debugging code that's already correct.

### Subagents (and same-model advisors) share my biases — orchestrator must counter-steer
Subagents and the `advisor` are usually the SAME model as me, so they inherit BOTH systematic biases
(overconfidence in claims; over-conservatism in scope = choosing the easy problem over the north star).
Fanning out work does NOT dilute the rationalization — it MULTIPLIES it: each agent, on hitting friction,
will quietly substitute the tractable version (e.g. "Orval regen is hard → cram it into the old type",
"setup gotcha → declare the ambitious loop infeasible") and report it back as done-and-prudent. A same-model
`advisor` verdict is NOT an independent check — it can launder my own easy-path pull through an authoritative
veneer (caught: advisor rendered a mixed-to-favorable fact set as a confident NO-GO on the ambitious build).
**My job as orchestrator is to keep them oriented to the north star, not to trust self-reports:**
- Brief the AMBITIOUS target explicitly + name the easy substitutions to avoid; re-steer the instant an
  agent drifts toward the tractable stand-in.
- Separate VERIFIABLE FACTS from JUDGMENT in any agent/advisor output; verify the load-bearing facts in the
  code/empirically myself; put GO/NO-GO on measured evidence, not on a same-model opinion.
- Default burden-of-proof on "we can't"; bias toward the north star unless evidence forbids it.
- Watch for the drift signature: agent hits a wall → picks the convenient mechanism → frames the scope-shrink
  as calibration. That's the tell in THEIR output exactly as in mine.


## pi-intercom — addressing, lifecycle, broker, dispatcher

### Addressing a peer: what resolves, what fails
The broker resolves a target by **display name** or **session UUID** (current,
post-Phase-1 broker — re-verify against the running broker if behavior surprises
you):

- **Display name (unique)** — works. The human label before the parens in
  `intercom list` (e.g. `app-build session`, `subagent-chat-aacd6b27`).
- **Full 36-char UUID** — works.
- **Unique ID prefix** (the 8-char form shown in parens) — works; an *ambiguous*
  prefix returns "Multiple sessions match ID prefix X. Use the full session ID
  instead."
- **Duplicate display names** block by-name routing entirely (e.g. two sessions
  with the same name after a fork): `to:"<name>"` errors with "Multiple sessions
  named X... Use the session ID instead." Workarounds: have the peer `/name`
  itself uniquely (`Twin-A`/`Twin-B`); get its full UUID via `intercom status`
  from *its* session. Prefer unique session names from the start.
- **Nonexistent id/name** — "Session not found".

"Session not found" is a *broker-side lookup* failure, NOT a peer-liveness
signal. If a short-ID send fails, retry the display name before concluding death.
(Liveness semantics of "Message sent" live in "Silence ≠ death" below.)

### Session identity is unstable: UUIDs cycle, display names drift
Neither identifier is a durable key:

- **UUIDs are re-minted on every `register`** — not just on broker restart but
  on *any* reconnect (network blip, broker socket hiccup, the pi process
  re-establishing its connection). The display name is preserved across all of
  these. (Consistent with reaper-plan §1: `register` mints a fresh UUID; the
  UUID is not a stable identity. A future broker could let clients re-claim a
  prior UUID via a stable token.)
- **Display names drift** when a session renames itself mid-life (e.g. from a
  broad scope to a narrow one as work focuses), so a name logged in an earlier
  turn can return "Session not found" later.

So: a short-UUID prefix logged in turn N may not resolve in turn N+5 (it
cycled), and a display name logged earlier may have changed. **Mitigations:**
- Refresh `intercom list` immediately before sending to any session after a
  multi-turn gap. Cheap.
- Prefer the display name over a logged UUID; if names collide, pull the UUID
  fresh from `list` right before sending — don't reuse an old prefix.
- Use a tolerant retry: try the last-known name, and on "Session not found"
  fall back to `intercom list` + match.
- Sessions that rename themselves should preserve discoverability — keep a
  stable prefix/suffix (`<broad scope> (narrow focus)`) or announce the rename
  on their next outbound.

(Observed repeatedly: by-name collisions blocking notifications to a forked
twin session; UUIDs changing hours apart and after a broker cutover; and a
send failing after the target renamed itself mid-task.)

### Silence ≠ death; design liveness probes to demand a reply
A pi session does NOT auto-process inbound intercom messages — it queues them in
the TUI and waits for the user (or the agent's next tool-turn) to engage. A
fully-live session will sit on an inbox message indefinitely if it has no reason
to act.

- "Message sent" → the broker had a writable socket FD to push to; peer almost
  certainly live (a much stronger signal than the absence of a too-narrow `ps`
  match) — though it doesn't strictly prove the peer is alive.
- No reply within N minutes → peer almost certainly STILL alive. The 10-minute
  `intercom ask` timeout is the *broker's* wait limit, not a peer-death signal.
- A probe that says "no action needed / no reply required" is **self-defeating**:
  a live, attentive session correctly ignores it, so silence can't distinguish
  live-and-obedient from dead. If you want a reply as a signal, ASK for one
  explicitly: "If this reaches you, reply with one line stating what you're
  doing — I'm building a session map."

**Reaper reframe:** the truly-dead-but-registered socket population is much
smaller than it looks — much of the raw broker FD count is legit per-session
multi-FD usage (register + tool channels + streams), not zombies. The underlying
reaper-plan bugs are real (no PID-based liveness sweep; `send` not gating on
writability; misleading addressing UX) but the "50+ zombies" urgency was overheated.

### Send/reply reliability: narration vs. tool call, and reply routing
- **"Report back via intercom" often gets narrated, not invoked.** A briefed
  session may emit a natural-language "Verdict sent: APPROVE_WITH_NITS" in its
  pane without ever invoking the `intercom send` tool — the same failure shape as
  "I'll fix X" without running an edit. The dispatcher never receives it.
  Mitigations: brief the *literal tool call* ("your last action MUST be an
  `intercom send` tool invocation with this content"); verify via
  `intercom pending` / inbox and re-ping if the pane says "sent" but nothing
  arrived; or have review sessions encode the verdict in their display name so
  `intercom list` itself is the channel. (Observed during a blind PR review.)
- **The dispatcher is NOT immune.** Under context pressure / many parallel
  threads, the dispatcher confabulated a subagent's A/B/C proposal *before*
  receiving it and presented it as the subagent's output. Before
  presenting any subagent output, scan the actual conversation for the matching
  `📨 From …` inbound; if there isn't one, say "still in flight, no output yet"
  rather than fabricate. When unsure, run `intercom list` + check session state
  ([idle] vs [tool:intercom]) before claiming a session reported back.
- **`intercom reply` (no explicit `to:`) routes to the active/single pending
  ASK — not the last message you read.** Non-ask `send` messages don't establish
  a reply target, so a bare `reply` can land on a session whose ask preceded the
  recent inbound by turns. Safe pattern: use explicit `intercom send
  to:<display-name>` for reports; use `reply` only immediately after answering a
  specific `intercom ask`. (Observed: an ack meant for one session got routed
  to an unrelated `subagent-chat-…` via a bare `intercom reply`.)

Intercom behavior notes here were observed pre/around the 2026-05-29 broker
cutover; re-check against the running broker's actual code before relying on them.

### pi-intercom-tailnet relay: virtual-session loop + broker-restart gaps

Two durable behaviors when relaying remote peers as local virtual sessions
(`<name>@<host>` registered on the LOCAL broker): (1) the broker↔broker echo
loop is real — virtual sessions must be filtered from re-broadcast by BOTH
broker-assigned id AND display name (the echo can arrive before the id
resolves), and this filtering is load-bearing (a post-fix code audit wrongly
reads as "no loop"). (2) A local broker restart drops all relay sockets while
cross-host peer links stay up and don't re-send their lists, so virtual sessions
must be rebuilt from retained peer state on reconnect, else they zombie onto
dead sockets. (Security posture: broker dir 0700 + socket 0600; reconnect
eviction gated on matching pid; inbound hello host bound to `tailscale whois`,
fail-closed; frame size capped.)


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

The pi-coding-agent binary's argv[0] in `ps` output is simply `pi`, not
`pi-coding-agent` or `@earendil-works/...`. A `ps | grep` for the package name
returns zero hits even on a machine with 20+ live sessions. Use:

```bash
ps -axo pid,ppid,etime,command | awk '$4=="pi" || $4 ~ /\/pi$/'
# complementary signal:
tmux list-panes -a -F '#{pane_current_command}' | awk '$1=="node"' | wc -l
```

Always sanity-check process counts with `tmux list-panes` and broker-side ping
success before recommending a broker restart — a narrow package-name grep will
badly undercount and could lead you to kill a PID that wipes out live sessions.

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

Discovered while probing a container's env for a set/unset secret. The buggy pattern accidentally printed the full secret value into the pi conversation. Not externally leaked, but a real footgun for any secret-probe shell.

### tlink pi-notification (desktop notifications on pi turn-end)

`tlink` (github.com/ahnopologetic/tlink) gives pi desktop notifications +
clickable `tmux://` deeplinks back to the exact pane. Setup: install the binary,
run `tlink setup` (interactive TUI — compiles a Swift app + registers the
`tmux://` URI scheme, macOS only; must be run by the human, can't be driven
headless), then `tlink install pi-notification` (writes
`~/.pi/agent/extensions/pi-notification.ts`; default event = `agent_end` = "pi
finished a turn / waiting for input"). Reload pi after install.

Gotchas:
- The installer appends `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc`; on
  a dotfiles-stowed `.zshrc` where `.local/bin` is already on PATH this is a
  redundant tracked-file edit — remove it after install.
- **The released binary can lag repo `main`.** If you hand-write the extension
  from `main` but run an older binary, drop flags the binary's `notify` rejects
  (e.g. `--source pi` → exit 2).
- Default `notification_method` is `osascript` (not terminal-notifier). The
  adapter does `display notification` THEN `open location "tmux://..."`; before
  `tlink setup` registers the scheme, the open-location step throws AppleScript
  error `-10814`, but `notify` still exits 0 and the banner still shows. The
  error disappears once setup is done.

### Slack MCP wrapper (dotfiles `pi/.pi/agent/extensions/slack-mcp/`)

A directory extension (entry `slack-mcp/index.ts` + sibling modules — edit the
relevant module, not a monolith; `just pi-check` typechecks it). Thin pi bridge
spawning korotovsky/slack-mcp-server (Go, npm `slack-mcp-server`) via
`~/.pi/agent/slack-mcp.json` (XOXP user token, not stowed). NOT the official
`@modelcontextprotocol/server-slack` — CSV output,
`conversations_search_messages`, `conversations_unreads` are korotovsky-only.
- **`from:@me` / `to:@me` silently return ZERO rows** — `@me` is not a valid
  Slack search modifier. Use `from:<user_id>`; the `slack_mcp_whoami` tool
  (direct auth.test, cached) returns the authenticated user_id.
- **Config knobs:** `requestTimeoutMs` / `requestTimeoutMsByTool` (the default
  per-call timeout was a hardcoded 60s — what made `conversations_unreads` over
  ~60 channels time out); and `postProcess` (CSV cleanup: drops wide cols,
  truncates Text at maxTextLength=2000, resolves `<@U…>`→@name). Dropping
  `Cursor` preserves pagination via a `next_cursor:` footer. `"postProcess":
  false` disables. Per-call escape hatches on history/replies/search_messages:
  `_maxTextLength` (0=none) and `_raw` (true=fully raw), stripped before forwarding.
- **Reload gotcha:** pi loads this extension once at session start; editing it
  does NOT affect running sessions (same long-running-process rule as the broker).

### pi extension loading internals + typecheck harness (dotfiles)

How pi loads `~/.pi/agent/extensions/`, verified by reading
`pi-coding-agent/dist/core/extensions/loader.js`:

- **Loader = `jiti`** (Node/dev mode). It aliases the `@earendil-works/*` SDK
  specifiers and `typebox` to pi's OWN bundled copies, transitively. So a local
  `node_modules` next to an extension does NOT shadow the SDK at runtime — safe
  to add one for tooling.
- **Discovery (one level, no recursion):** auto-loads top-level
  `extensions/*.ts|*.js`, plus a subdir only if it has `index.ts`/`index.js` OR
  a `package.json` with a `pi` manifest field. A helper subdir like `_shared/`
  WITHOUT an index is ignored — perfect for shared code imported relatively. Do
  NOT add index.ts there or it becomes an extension.
- SDK packages live under the global install (`pi` → realpath →
  `<prefix>/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`).
  `TextContent`/`ImageContent` are NOT re-exported from pi-coding-agent — import
  them from `@earendil-works/pi-ai`.
- **Typecheck harness:** `just pi-check` (`just pic`) → `scripts/pi-typecheck.sh`
  builds a gitignored `extensions/node_modules/` symlink farm pointing at the
  installed SDK, then `tsc --noEmit` (strict). Pins typecheck to the running pi
  version, build-time only (jiti aliasing makes the farm runtime-inert). Verify
  changes with `just pi-check` AND a runtime load probe via
  `discoverAndLoadExtensions([], cwd, agentDir)` checking `res.errors` is empty.
- Shared layered-config loader is `extensions/_shared/config.ts`
  (`loadLayeredConfig`: defaults < `~/.pi/agent/<file>` < `<cwd>/.pi/<file>`,
  warn-and-ignore malformed JSON).

### dotfiles agent skills live in `.agent/skills/`, NOT the pi stow package

Cross-harness agent skills in dotfiles belong in
`dotfiles/.agent/skills/<name>/SKILL.md` (tracked in git). `install.sh`
(`setup_agent_skills`) symlinks that one dir into `~/.pi/agent/skills`,
`~/.claude/skills`, `~/.gemini/skills`, etc. so every harness shares it.

Footgun: do NOT put skills under `pi/.pi/agent/skills/` in the pi stow package.
That path is `.gitignore`d (meant to be the install.sh symlink); if you create a
real dir there, `just stow` hijacks `~/.pi/agent/skills` to point at the pi
package instead of `.agent/skills`. Fix: remove `pi/.pi/agent/skills`, recreate
`~/.pi/agent/skills -> dotfiles/.agent/skills`.





## git, worktrees & PR mechanics

### "Structural-superset wins" merge resolution can silently undo cross-file surgery

When folding two long-lived branches, the per-file "take the structurally richer
side" heuristic misses cross-file coupling: if branch A deleted code from file X
and added a replacement file Y, while branch B evolved X into a superset (never
seeing Y), the merge keeps B's superset X (resurrecting A's deleted code) AND
A's Y (unconflicted) — both incompatible designs survive, with Y now orphaned
but import-clean, so it fails only in subtle factory-shaped ways, not loudly.

Defenses when merging long-lived branches:
- `git log -p <ancestor>..<branch> -- <file>` *both sides* before resolving;
  watch for **deletions** on the "smaller" side — often load-bearing for
  additions elsewhere in that branch's diff.
- For any file new on only one side, `rg <ClassName>` (or the filename stem)
  across the post-merge tree to confirm an importer remains. Zero importers =
  silent orphan.
- Run the test suite (and each side's *own* suite) on the merged tree before
  pushing — "no conflict markers + lint passes" does not mean semantically clean.
- If the merge agent flags an orphan as a follow-up, treat it as a yellow flag:
  verify *why* it ended up orphaned before deciding delete vs. port.

### Worktree triage discipline

Lessons from triaging multi-worktree layouts (one primary clone + N secondary
worktrees via `git worktree add`). Read state, don't infer it:

- **Branch redundancy: use tree-equivalence / patch-id, not SHA or subject
  lines.** Cherry-picks/rebases/squashes change SHAs and subjects, so a branch
  can be fully redundant while looking net-new.
  ```bash
  git rev-parse <sha>^{tree}          # tree hash — compare across sides
  git patch-id < <(git show <sha>)    # stable across cherry-pick
  git cherry <upstream> <branch>      # "+" = not in upstream, "-" = already in (by patch-id)
  ```
  `git branch --contains <sha>` is only *coincidentally* correct (when commits
  touch disjoint files from prior picks); default to `git cherry`/`git patch-id`.
- **"What does this set of commits touch?" — per-commit, not cumulative.** A
  two-tip `git diff --name-only Y..X` also surfaces unrelated divergence between
  the tips. Use per-commit stats:
  ```bash
  for sha in <sha1> <sha2> ...; do git show --stat --format= $sha; done
  # or, contiguous range, no merges:
  git log --no-merges --stat <oldest>^..<newest> --format='%h %s'
  ```
- **Never classify uncommitted work by path/filename — read the diff.** Files
  like `settings-dev.toml` or `deploy.yaml` often hold real bug fixes, prod
  tuning with runbook commentary, env overrides the env literally can't run
  without, or deliberate `.bak` safety snapshots. For each `M`: `git diff
  <file>` (dump head -40 if >5 lines); for each `??`: `head -40` and show the
  user what it is. Untracked tests and snapshots are not noise.
- **The primary clone hosts side-effects from ALL its worktrees.** Uncommitted
  state there is NOT attributable to the session whose registered cwd is the
  primary — that field tells you where a session *launched*, not where it works.
  Docker dev-mounts (set up against the primary path), local config/secrets, and
  ad-hoc edits all land there from any session. Identify the real owner by diff
  content / signature naming / mtimes / sibling worktree / asking via intercom.
- **"PR merged → worktree safe to remove" needs a usage guard.** A session may
  still be using a merged worktree (benchmarking the merged path, post-merge
  stress tests, or as a working dir unrelated to the branch's diff). Re-verify
  "no live attachment" *immediately before each destructive op*, not just at
  proposal time — sessions can attach between proposal and execution:
  ```bash
  lsof +D <worktree-path> 2>/dev/null | head                                # process cwd here?
  tmux list-panes -a -F '#{pane_current_path}' | grep -F "<worktree-path>"   # tmux pane here?
  intercom list | grep -F "<worktree-path>"                                 # pi session here?
  ```

### `gh pr view` PR-object cache lags fresh pushes by seconds

For fresh-push verification, `gh pr view <num> --json headRefOid` can
return the *pre-push* SHA for a few seconds after a successful push.
The git refs REST endpoint is consistent immediately:

```bash
# Lagging (PR-object cache):
gh pr view <num> -R <org>/<repo> --json headRefOid -q .headRefOid

# Immediate (git refs):
gh api repos/<org>/<repo>/git/refs/heads/<branch> -q .object.sha
# or:
gh api repos/<org>/<repo>/branches/<branch> -q .commit.sha
```

For automated verification scripts, prefer the refs API. For
human-readable PR state, sleep+retry on `gh pr view` is fine but be
aware of the staleness window.

Observed twice during a cherry-pick push to a PR: push completed, the refs API
returned the new SHA instantly, but `gh pr view` returned the old SHA for ~5s
before catching up.

### `git checkout --theirs <file>` during a cherry-pick silently drops auto-merged content

`git checkout --theirs <file>` replaces the working-tree file with the COMPLETE
file from the picked commit's tree — it is NOT "accept the picked side at each
conflict hunk". It throws away auto-merged hunks outside the conflict region, so
it's safe **only when** HEAD has zero post-merge-base edits outside the
conflict. If A made non-conflicting improvements to `foo.py` and you `--theirs`
it while cherry-picking B's small change, A's improvements silently disappear
(tests may miss it; lint won't — the file is still valid).

Right way: hand-edit the conflict markers, keeping the theirs side and leaving
auto-merged regions untouched (`git checkout --conflict=diff3` / `git mergetool`
make the lost base visible). Pre-flight check before using `--theirs`:
```bash
git diff <picked-commit>^ HEAD -- <file>             # ours-side drift
git diff <picked-commit>^ <picked-commit> -- <file>  # what the pick actually changes
```
If the ours-side drift extends beyond what the pick touches, hand-resolve instead.

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
is shallow, they all are. Unshallow once in any of them and the rest resolve.

Discovered while rebasing a branch onto a teammate's newly-advanced tip — the
rebase hit 27 phantom AA conflicts, traced to shallow state; `git fetch
--unshallow` then let the rebase resolve cleanly to the real merge-base with
just 3 actual file conflicts.

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

Discovered renaming a branch with an open PR — the PR closed silently and had
to be re-opened as a new PR number.

### Cherry-pick discipline: hooks-after-early-returns bug class

When cherry-picking a React component into a host page with existing early-return
guards (loading/error/empty), a newly-added hook call placed AFTER one of those
guards violates Rules of Hooks. Symptom: "Rendered more hooks than during the
previous render" at runtime — `build`/`test`/`typecheck` all pass, only the
browser render cycle catches it. The PR diff looks innocent in isolation; the
violation only emerges in the host context.

Fix: move the new hook ABOVE all early returns; handle "data not ready" via
optional chaining (`useQuery`-backed hooks recompute their fetch on dep change):
```javascript
export function WorkspacePage() {
  // ... existing hooks ...
  const customerIdentity = useCustomerByName(w.data?.customerName ?? ''); // ✓ top, every render
  if (w.isLoading) return <Loading/>;
  if (w.isError) return <Error/>;
  // ... render using customerIdentity ...
}
```
Rule: for any cherry-pick that introduces a new hook to a host page, verify the
hook is called before any conditional return.

### Don't infer architecture / data-flow from file or directory names — read the flow

Architectural guidance based on directory/file names is unreliable, and the
error compounds when a dispatcher hands a naming-based guess to another session
as if it were fact. Two recurring failure shapes:

1. **Assuming a structure that isn't there.** Scoping a fix around an assumed
   rendering/integration architecture (e.g. "there's an iframe shim") when the
   code actually does something simpler (a plain component in a shared router).
   A read-only agent that read the real code found no such shim — but a
   workaround commit message had already shipped the false claim.

2. **Inferring a module's role from its name.** Telling a session a new seam
   should sit "parallel to the `X/` package" because the name *sounds* like the
   relevant substrate — when reading the actual route-read path showed `X/` was
   unrelated infrastructure and the correct seam was elsewhere in the flow.

Workflow rule: when asked "where should X slot into codebase Y?" and I haven't
read Y's actual flow end-to-end:
1. Pull the seam-question to a session that HAS read it — dispatch a read-only
   survey, get a code-grounded answer, route it back.
2. Or explicitly preface my answer with "I haven't read this codebase's flow —
   verify by reading X/Y/Z before acting on my guess."
3. Never present an inferred-from-naming architectural claim with the same
   confidence as a session that has actually read the code.

Companion rule: the session that did the read-only survey of the target
codebase is the source of truth for the seam shape. Its answer overrides any
naming-based intuition from sessions (including the dispatcher) that haven't.

## process & collaboration discipline

### GitHub / forum communication preference

Do not post in GitHub forums (PR review threads, issue comments, discussions,
review-thread replies, "resolve conversation" actions, etc.) on the user's
behalf unless explicitly asked to do so in that turn.

This includes:
- Replying to PR review comments (e.g. from CodeRabbit, claude-review, or
  human reviewers)
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

Established after posting `@coderabbitai resume` on a PR without being asked.

### PR-campaign hygiene: "we measured" vs "we suspect"

When shipping multi-PR fixes under time pressure (esp. with parallel
subagents), the bias-toward-action that gets code right also tends to
over-claim in PR descriptions. Concrete claims like "720× amplification"
or "fully hung" get written in the heat of the moment as if observed
when they were actually inferred / arithmeticked / extrapolated.

**Pattern that worked** (a multi-repo, multi-PR perf campaign):

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
3. If a claim is inferential, either MEASURE it (e.g. a 10-min local probe
   turned an arithmeticked guess into a measured number for the PR) or
   downgrade the language ("suspected", "estimated", "extrapolating").
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

### Verify prior-art / repro before reverting or re-fixing a bug

Two related rules for bug-fix work, both learned on the same frontend routing bug
(clicking a shell sidebar link to leave a sub-app changed the outer URL but the
sub-app UI stayed mounted; of the fixes tried, only a `window.location.assign`
hard-nav worked — a synthetic PopStateEvent, a full useNavigate/useLocation
conversion, and a generic anchor-intercept all did NOT):

- **Survey prior-art with the bug-hitter BEFORE dispatching a fix plan.** Get the
  exact observed symptom (vs. the inferred mechanism), what fixes were already
  tried and which failed, and what signals they did NOT see. Feed it to the plan
  agent as hypothesis-constraining evidence, not background reading — it should
  explicitly reconcile its recommendation against the failed attempts. (A plan
  agent once re-recommended the already-failed useNavigate conversion because it
  scoped from code-reading alone.) Paraphrase every report into "what symptom was
  observed" + "what mechanism it is therefore NOT"; the negative evidence is half
  the information ("outer URL changes, UI stays mounted" = a mount/unmount problem,
  NOT the hypothesized "URL gets rewritten back").
- **Partial reverts of workarounds are risky without a repro.** Before "revert
  the workaround half, keep the real-fix half", confirm with the author or by
  re-running the repro that the kept half fixes the bug on its own. A diff can
  look like two independent changes when the bug needs both halves in concert;
  partial revert then silently regresses the fix while appearing to preserve it.
  Don't infer "this looks like architecture, this looks like a hack" from the
  diff alone.

## Memory curation (how to maintain this file)

First consolidated 2026-05-29. Guidelines for keeping this file useful:

- **Three tiers.** `daily/` is the append-only log (timestamped, may contain
  duplicates + later corrections); `SCRATCHPAD.md` is for uncertain/temporary
  reminders; this file (`MEMORY.md`) is durable long-term memory.
- **Two scopes for durable memory (pick deliberately).** The pi-memory plugin
  splits durable memory into `MEMORY.md` (**global** scope, the default) and
  `MEMORY.local.md` (**local** scope). Both are injected into the system prompt
  as separate labeled sections; `search` spans both.
  - **global = `MEMORY.md`:** portable facts/preferences that hold across ALL
    machines and contexts (general working-style preferences, tooling/process
    lessons, anonymized footgun patterns). This file is version-controlled and
    synced, so keep it free of machine-specific or employer/project-specific
    detail — anonymize lessons before promoting them here.
  - **local = `MEMORY.local.md`:** facts specific to THIS machine — its role
    (e.g. work vs personal), machine-bound paths, git identity, and
    machine/project-specific operational context. Not synced.
  - When appending durable memory, set the `memory` tool's `scope` (`global`
    default / `local`) accordingly. Litmus test: "would this be true/useful on a
    different machine?" → global; "is this about this box, this employer, or a
    specific local project?" → local.
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
