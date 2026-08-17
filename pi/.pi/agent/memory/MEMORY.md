# Long-term memory

Portable, anonymized guidance suitable for a public dotfiles repository.
Personal preferences, workplace context, authentication behavior, operational
topology, and incident details belong in local memory instead.

## Core operating principles

- Prefer concise, practical, evidence-backed answers.
- Prefer root-cause fixes and small, targeted changes.
- Distinguish observed facts, inferences, and unverified claims.
- Do not substitute an easier proxy for the requested outcome. Ask whether an
  approach is right for the goal or merely more tractable.
- Confirm before destructive actions or changes to shared resources.

## Concurrent work safety

- Shared working trees may be edited by multiple sessions. Use a dedicated
  worktree or `git add -p`; plain `git add <file>` can stage another session's
  changes.
- Re-read `git status`, recent log, reflog, and the actual diff before acting in
  a resumed or long-lived session.
- Verify handoffs and status reports against the current diff. Describe what
  shipped, not what was attempted.
- Re-fetch and coordinate before rebasing or force-pushing a shared branch.
- Check for live users before deleting worktrees, killing processes, or
  restarting shared services.

## Verification discipline

- Verify runtime-installed state, not only source code and tests. For database
  or index changes, confirm that the intended schema objects actually exist.
- Long-running processes do not pick up source edits automatically. Compare
  process start time with code history before debugging code that may already
  be fixed on disk.
- After resolving conflicts, search for leftover conflict markers before
  continuing or committing.
- Do not infer architecture or data flow from file and directory names; read
  the actual call path.
- Never expose a secret while checking whether an environment variable is set.
  Avoid concatenated `${VAR:+...}${VAR:-...}` expansions; use an explicit test:

  ```bash
  if [ -n "${VAR:-}" ]; then echo "set length=${#VAR}"; else echo unset; fi
  ```

## Delegation and subagents

- Sweep and size the work surface before delegating. Parallel agents are useful
  for broad, independent work; small edits are often cheaper in-session.
- Delegate parallel breadth while retaining global coherence centrally.
- Treat requested isolation as unverified until each agent's actual worktree,
  branch, and path ownership are confirmed.
- Verify load-bearing claims and inspect outputs rather than trusting agent
  self-reports. Same-model advice is not independent evidence.
- Resolve relative deadlines from the source message's timestamp, not from the
  day the message is later processed.

## Git and GitHub mechanics

- Resolve merges by preserving cross-file intent, not by choosing whichever
  side appears to be a structural superset.
- During a cherry-pick, `git checkout --theirs <file>` replaces the whole file;
  it is not a conflict-hunk-only operation. Inspect the staged diff afterward.
- If a rebase produces an implausibly large conflict set, check whether the
  repository is shallow and fetch the real merge base.
- Avoid renaming branches with open pull requests; update the PR title and
  description instead.
- GitHub's PR object can lag the refs API briefly after a push. Use the refs API
  for machine verification and retry human-readable PR queries.
- React hooks must run before conditional returns. Cherry-picks that move early
  returns can make previously valid hooks conditional.

## Pi and dotfiles maintenance

- Restart long-running Pi extensions and daemons after source changes.
- Pi session processes are named `pi`; do not rely only on interpreter names
  such as `node` when checking liveness.
- Verify extension changes both with TypeScript and by loading the runtime
  module graph through Pi's bundled loader.
- Keep implementation-specific package behavior in package documentation,
  source comments, and tests rather than duplicating it in global memory.
- Cross-harness agent skills belong in the repository's canonical tracked skill
  directory, with runtime directories linked to that source.

## Communication and claim quality

- Separate measured results, supported inferences, and extrapolations.
- Do not claim performance, correctness, or risk reduction beyond what the
  validation actually exercised.
- Reconcile recommendations with prior attempts and reproduce the current
  behavior before reverting or re-fixing a bug.
- Do not claim a subagent result until the result was actually received and
  inspected.

### Document prose: remove chain-of-thought narration

For shared documents, write the conclusion, evidence, decision, trade-offs, risks, and open questions directly. Remove internal-reasoning narration, discovery-story prose, rhetorical self-dialogue, and phrases such as “the design tell,” “why this shape is right,” “this dissolves the fork,” or “the strongest argument.” Preserve concise rationale and traceable evidence; do not expose or simulate the author’s chain of thought.

### Inter-process coordination

Do not request draft approval for pi intercom messages exchanged with other local agent sessions for ownership checks, conflict avoidance, status coordination, or similar inter-process communication. Reply directly and succinctly.

## Memory hygiene

- Public/global memory contains only portable, anonymized rules that should
  affect future behavior.
- Local memory contains personal preferences, machine paths, workplace context,
  authentication practices, operational topology, and sensitive incident
  details.
- Project memory contains durable architecture and workflow facts specific to
  the current repository.
- Daily memory and scratchpads contain ephemeral state and uncertain findings.
- Keep a lesson only when it would prevent a real mistake or recurring footgun.
- Prefer one canonical rule over repeated anecdotes. Preserve the behavioral
  lesson and remove names, dates, metrics, and incident narration.
- Never store credentials, tokens, private keys, or third-party personal data.
