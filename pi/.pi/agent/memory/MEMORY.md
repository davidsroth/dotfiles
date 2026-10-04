# Long-term memory

Portable, anonymized operating lessons for the public dotfiles repository.
General style and environment defaults belong in agent instructions; private
preferences, workplace context, and machine details belong in local memory.

## Outcomes and authorization

- Optimize for the requested user-visible outcome, not an easier technical
  proxy. Prefer complete useful workflows and bounded real-world pilots over
  metadata-only slices or extensive mock-only scaffolding.
- Plan approval means proceed within that plan; do not ask for redundant
  permission. Preserve separately gated actions and exclusions, especially
  confidential disclosure, authoritative changes, and deployment.
- Confirm destructive or disruptive changes to shared resources. Check for live
  users before deleting worktrees, killing processes, or restarting services.

## Concurrent work and handoffs

- Shared working trees may have multiple writers. Use a dedicated worktree or
  precise hunk staging; plain `git add <file>` can include another session's work.
- Before acting after a pause, re-read current status, relevant log/reflog, and
  the actual diff. Verify handoffs against live state; report what shipped, not
  what was attempted.
- Re-fetch and coordinate before rebasing or force-pushing a shared branch.
- Preserve cross-file intent during merges rather than choosing whichever side
  looks like a structural superset. Search for conflict markers afterward.

## Verification discipline

- Verify installed/runtime state, not only source and tests: schema objects,
  effective configuration, dependency origins, and the actual request-serving
  process. Compare process start time with source changes before debugging code
  the running process has not loaded.
- Read actual call paths; do not infer architecture or data flow from names.
- Separate measured results, supported inferences, and extrapolations. Do not
  claim correctness, performance, or safety beyond what validation exercised.
- Reconcile recommendations with prior attempts and reproduce current behavior
  before reverting or re-fixing a bug.
- Never expose secrets while checking environment state. Use an explicit test,
  not concatenated parameter expansions that may reveal the value:
  ```sh
  if [ -n "${VAR:-}" ]; then echo "set length=${#VAR}"; else echo unset; fi
  ```

### Protocol-stream ownership

Give each protocol stream one serialized writer. Mixing asynchronous writes
with raw synchronous writes can interleave records; pipe writes can also be
short under backpressure. Use a backpressure-aware writer and test real OS pipes
with concurrent large frames and slow readers. Separate channels still need
completion ordering when reports must arrive before completion is announced.

### Dependency qualification

Installation-capable package-manager run/exec wrappers can reinstall dependencies
when HOME or store settings change, even for code generation. With borrowed
symlinked node_modules this can delete a shared target before a network-denied
install fails. Invoke installed entrypoints directly for hermetic tests/builds;
verify dependency links and executable bytes after recovery.

## Delegation and agent communication

- Size the work before delegating. Use parallel agents for independent breadth;
  keep global coherence centrally. Small edits are often cheaper in-session.
- Verify actual worktree, branch, and path ownership before relying on isolation.
- Inspect received outputs and load-bearing evidence. Same-model review is not
  independent evidence; never claim a subagent result before receiving it.
- Use `aside_subagent` for non-interrupting progress checks; use `steer_subagent`
  to redirect a child or deliver a correction. An intercom acknowledgement does
  not prove entry into the child's active conversation. Narration is not delivery.
- Local agent coordination over intercom does not need user message-draft
  approval. External communication remains subject to its approval tools.
- Resolve relative deadlines from the source timestamp, not processing day.

## Git and frontend footguns

- During cherry-pick, `git checkout --theirs <file>` replaces the entire file,
  not just conflicting hunks. Inspect the staged diff.
- If a rebase creates an implausible conflict set, check for a shallow clone and
  fetch the real merge base before resolving.
- Avoid renaming branches with open PRs; update the PR title/description instead.
- GitHub's PR object can lag pushed refs. Verify the refs API and retry the PR read.
- React hooks must precede conditional returns; cherry-picks can move early
  returns and make previously valid hooks conditional.

### Isolated commit-snapshot validation

Pre-commit stashes tracked unstaged changes but leaves future untracked modules visible; full-project typechecks can therefore fail on a partial staged feature. Validate/hooks against an exact isolated staged-tree export rather than bypassing checks. If using `GIT_WORK_TREE` with a shared index, disable fsmonitor/untracked-cache for those commands and clear the index's fsmonitor state afterward: cached results from the alternate tree can otherwise hide real source edits from `status` and `add`.


## Pi and package maintenance

- Pi processes are named `pi`; do not look only for `node` when checking liveness.
- Validate extension changes with typechecking and Pi's actual installed module
  loader. Reload/restart long-running runtimes with appropriate authorization;
  source edits alone do not activate changes.
- Canonical cross-harness skills belong in a tracked source directory; runtime
  directories should link to it. Keep package implementation detail in package
  docs/tests rather than duplicating it in global memory.

## Shared-document prose

Write conclusions, evidence, decisions, trade-offs, risks, and open questions
directly. Remove discovery-story prose, rhetorical self-dialogue, and simulated
internal reasoning. Preserve concise rationale and traceable sources.

### Copy-ready text
When giving the user text they should be able to copy, put it in backticks (use a fenced code block for a full message).


## Memory hygiene

- One canonical home per fact: public/global for portable anonymized lessons;
  local for private preferences and machine/cross-repo context; project for
  repository-specific decisions. Project location alone does not guarantee Git
  tracking, syncing, or availability in another worktree.
- Scratchpad holds unresolved work and candidate facts; daily/archive holds
  dated history. Neither is proof of current external state.
- Keep lessons only when they prevent real recurring mistakes. Consolidate
  duplicates and point to maintained authorities instead of copying runbooks,
  validation counts, or incident chronologies into active memory.
- Never store credentials, tokens, private keys, or third-party personal data.
