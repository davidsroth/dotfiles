# pi-memory

Filesystem-backed Markdown memory for Pi. No network, embeddings, database,
automatic semantic consolidation, or automatic task completion.

## Storage and portability

Uses Pi's exported `getAgentDir()` resolver (normally `~/.pi/agent`, including
Pi's handling of `PI_CODING_AGENT_DIR`):

```text
<agent-dir>/memory/
  MEMORY.md                 # Global curated memory; intentional symlinks supported
  MEMORY.local.md           # Machine-local curated memory
  SCRATCHPAD.md             # Follow-ups and uncertain reminders
  project-approvals.json    # Local-only project-injection approvals/revocations
  daily/YYYY-MM-DD.md        # Historical, append-only through this tool
  archive/**/*.md           # Explicitly requested central history
<project-root>/.pi/memory/
  MEMORY.md                 # Current project's curated memory
  archive/**/*.md           # Explicitly requested current-project history
```

The project root is the nearest ancestor of the session cwd containing a `.git`
entry (directory or worktree file), otherwise cwd. The project config directory
uses Pi's `CONFIG_DIR_NAME`. Project memory is created lazily on the first write.
Only the three central active files are initialized at session start. Templates
contain purpose/empty sections, **no assumed user preferences, environment facts,
or invented follow-up tasks**.

**Location does not guarantee Git tracking, sync, or availability in another
worktree.** Global memory can be linked to a tracked file, but the extension does
not configure sync. Local memory and the approval file should remain private.
Project memory may be ignored/untracked; check the repository's actual policy.

## Automatic injection and project approval

Global/local curated memory is injected on each turn. Scratchpad, daily logs,
and archives are never automatically injected. Missing files are omitted;
non-ENOENT read failures are surfaced as notifications, not silently hidden.

Project injection requires active `ctx.isProjectTrusted()` **and** affirmative
approval covering the canonical **source project root**. Pi automatically returns
true for projects with no recognized resources; `.pi/memory` alone is not one of
those resources. This extension does not treat that shortcut as approval.

Any of these affirmative sources suffices:

- Active host trust for a resource-gated cwd that is the canonical project root
  (`hasTrustRequiringProjectResources`). Existing legitimately trusted roots do
  not need an additional opt-in.
- A positive saved host `ProjectTrustStore` decision for the canonical root or an
  ancestor, resolved through the public API.
- A confirmed `/memory approve-project` command in the interactive TUI, stored
  locally by canonical root in `project-approvals.json`.

A trust decision for a **nested cwd alone does not authorize its ancestor's
memory**. A memory-only root without affirmative approval stays excluded even
when the host's default is `always`. Host-inactive trust (including CLI denial)
always blocks injection. In the memory-only/nested fallback, a saved host denial
also blocks a memory-specific opt-in. `/memory revoke-project` writes a local
negative override that blocks injection even with active host trust. Both
commands require explicit TUI confirmation; the model tool cannot authorize
injection. There is no noninteractive auto-approval. Approval is reevaluated each
turn; malformed/unreadable approval state fails closed with a notification.

Explicit model/user tool reads and searches remain available, including project
memory: this is an automatic input-loading guard, not a filesystem sandbox.
`memory audit` explains effective approval and injection eligibility.

Each complete injected scope block, **including label, outline and retrieval
instructions**, is capped at 12,000 UTF-8 bytes (also no more than 12,000 UTF-16
units) and 650 lines. All three together add at most 36,006 bytes / 1,956 lines
of memory to the existing prompt. Large files expose a bounded **partial**
outline and an exact read/section/cursor retrieval path. Audit reports source
size, injected body-character coverage and total rendered bytes separately.

## Tool interface

The tool is `memory`. Existing actions/scopes are retained; invalid operations
throw real errors so Pi sets `isError: true`.

| Action | Behavior |
|---|---|
| `read` | Default: global curated memory. `target=memory` with `scope=global/local/project`; `target=scratchpad`, today's `daily`, or `all`. `all` reads present active files plus today's log, not history. Optional `section` for a unique existing memory heading. |
| `search` | Case-insensitive literal line search, default 30 results/page, integer `limit` 1–100. See changed defaults below. |
| `append` | Default: global memory. Memory accepts a Markdown block; `section` inserts beneath an existing unique heading. To create a heading, append a block beginning with `## Title` without `section`. Scratchpad adds an unchecked item; daily adds a local-time timestamp. |
| `replace` | Exactly one literal occurrence in memory or scratchpad; dollar sequences are preserved literally. Rejects zero, multiple, or overlapping matches. Daily is append-only. |
| `scratch_done` | Marks exactly one unfenced unchecked scratchpad item matching `query` (or `text`). Does not complete nested pending items. |
| `audit` | Read-only, metadata-only inventory; optional target/scope filters. No memory excerpts, task text, heading titles, or semantic judgments. |

`scope` defaults to global for memory reads/writes. Omitted scope means all
applicable scopes for search/audit; scope alone filters to that curated memory
scope. Scratchpad/daily have no scope. `section` is for memory read/append only.
Missing or case-insensitively duplicate headings are errors. ATX headings and
checkbox operations respect backtick/tilde fences, including run lengths and
valid closing fences; this is not a full Markdown AST parser.

### Search default changed: active first, history opt-in

**Old behavior recursively searched the central directory**, included backups
and history, and missed symlinked global memory. **New default** explicitly
searches only global memory, local memory, current-project memory, and scratchpad,
in that order. Canonical file symlinks are followed. No unrelated project is
searched implicitly.

- `target` and `scope` filter the selection; `target=all` is also accepted.
- `history=none` (default), `daily`, `archive`, or `all` adds the requested history
  **after** active files. `target=daily` itself explicitly selects daily history.
- Central archives are labeled `history:archive/local` (machine-local storage
  provenance, not a claim that every archived fact is machine-specific).
  Current-project archives are labeled `history:archive/project`.
- Daily matches are labeled `history:daily/machine`. History is dated evidence,
  **not current guidance**. Read its source and verify freshness before acting.
- Only explicit `daily/`, central `archive/`, and current-project `archive/` roots
  are walked. History symlinks, hidden entries, backup/rollback/bak-named paths
  and editor `~` backups are excluded. Unclassified Markdown elsewhere in the
  central store is not searched. Do not put backup bodies under ordinary archive
  names: arbitrary backup contents cannot be detected from prose.

Examples:

```json
{"action":"search","query":"release"}
{"action":"search","query":"release","scope":"project","history":"archive"}
{"action":"search","query":"incident","target":"daily"}
{"action":"read","scope":"local","section":"Environment"}
{"action":"audit"}
```

### Bounds and continuation

Read/search/audit text is capped at **50,000 UTF-8 bytes and 2,000 lines**, including
continuation instructions. Pagination never splits Unicode code points. Repeat
**the same arguments** plus the returned `cursor`; it is also available in
`details.nextCursor`. Cursors are stateless and survive extension reloads. Changed
read content, search inventory/file metadata, filters, or query invalidate a
cursor: restart without it rather than treating pages as a consistent snapshot.

Search pages stop at the result/output budget, 64 scanned files, or after reaching
16 MiB of scanned content (at most one additional file, up to 8 MiB). Even a page
with zero matches can return a continuation. Long matching lines/headings become
bounded excerpts with the exact path and 1-based line for the filesystem `read`
tool. Result details list only files scanned on that page, not an unbounded
history manifest.

Files larger than **8 MiB** are rejected with a filesystem-read instruction, not
silently ignored or overwritten. History inventory is bounded to 5,000 entries
per root and 16 directory levels; exceeding either limit is an explicit error
(use narrower history/scope or filesystem tools). These are bounded local scans,
not a persistent index. Audit inventories history metadata but does not read
historical bodies.

## Commands and audit

- `/memory` shows storage paths; optional `memory`, `local`, `project`,
  `scratchpad`, `daily`, or `dir` selects a path.
- `/memory audit` reports paths (including resolved symlink targets), byte/character/
  line counts, effective project approval, injection coverage, search tiers,
  duplicate-heading counts, malformed-heading line numbers, open/completed
  checkbox counts, and history totals. No semantic deduplication or task-state
  reconciliation is attempted. Large command reports continue with
  `/memory audit <returned-cursor>`.
- `/memory approve-project` and `/memory revoke-project` require interactive user
  confirmation. No model-callable approval action exists.

Audit/read/search do not initialize or repair memory files. Host trust lookup may
briefly create the host API's cooperative lock when an existing trust file is
consulted. Startup and path commands can initialize missing central files.

## Mutation safety and limits

Mutations participate in Pi's in-process `withFileMutationQueue` and additionally
acquire an atomic directory lock next to the **resolved target**, so cooperating
Pi processes using different symlink aliases serialize their complete read/modify/
publish windows. Initialization uses the same protocol. A five-second busy-lock
timeout fails without stealing a lock. `owner.json` records PID, hostname and time;
after a crash, verify that the owner is no longer running before manually removing
the specific `.pi-memory.lock` directory. Locks are never expired based on age or
PID alone. Do not remove an active lock.

Writes use an exclusive same-directory temporary file, retain POSIX owner/group
and mode bits, fsync its contents, verify the target still matches the read version,
and atomically rename it onto the resolved target. The original symlink stays
intact; new files use 0600 and new directories 0700. Existing permissions are not
silently tightened. Nonregular files, multi-hard-linked mutation targets,
foreign-owned files, dangling symlinks and non-ENOENT read failures are rejected.
Failures before rename leave the original file intact and clean up the temp/lock.

This is **cooperative**, not protection against arbitrary editors, malicious
filesystem races, cloud sync or noncooperating older extensions. A pre-publication
check catches many external edits, but cannot close the last check/rename race.
Atomic rename is not a transaction across files; directory fsync/power-loss
survival is not guaranteed. ACLs/extended attributes are not copied. A crash may
leave a temp file/lock requiring inspected manual cleanup. POSIX safety is tested
on the qualification host; Windows/network-filesystem semantics are not claimed.

## Validation (already-installed tools only)

From this package directory:

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
```

Tests use temporary stores only. They cover registered lifecycle/tool/command
paths, real host agent-loop error flags, actual separate-process symlink-alias
writes, failure cleanup, bounds/cursors/Unicode, history exclusion, and actual
host trust resolution (including its memory-only shortcut). Installed-loader
tests locate `pi` on PATH; override `PI_MEMORY_TEST_HOST_ROOT` with the installed
Pi package root when necessary. No package-manager wrapper/install is used.
Reload Pi deliberately to activate source changes; tests do not restart or reload
other running sessions.
