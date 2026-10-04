# pi-goal

Persistent `/goal` support for pi. The extension stores branch-local goal snapshots in the Pi session, with a compact above-editor goal widget, hidden continuation prompts, token/time accounting, and agent-callable tools.

## Local installation

This copy is vendored in `dotfiles/pi/packages/pi-goal/` and declared in the tracked `pi/.pi/agent/settings.base.json`. Run `just pi-settings` from the dotfiles root to merge that declaration into the live Pi settings, then restart Pi or run `/reload`. See [VENDORED_FROM.md](VENDORED_FROM.md) for the exact upstream revision.

**Do not use `pi install npm:pi-goal` for this copy:** the npm name currently resolves to a different plugin. For an isolated one-off test from this directory, run `pi --no-extensions -e ./src/index.ts`.

## Commands

```bash
/goal <objective>
/goal --recurrences 5 <objective>
/goal recurrences 0
/goal
/goal pause
/goal resume
/goal clear
```

Goals are versioned full-state `pi-goal:state` entries in Pi's session tree. `/tree` selects the latest snapshot on that branch; compaction does not remove it. Clearing a goal appends a null tombstone, so an old goal cannot reappear on that branch after reload. Forked sessions inherit snapshots on copied paths but report their new session ID. A session without a persisted file uses Pi's in-memory session entries (not the old directory fallback).

On first access to an existing session with **no goal-state entries anywhere in its tree**, the extension imports the validated legacy `<session-id>.json` goal or null marker, including an available matching `.objective-full.txt` sidecar. Import happens once; old files remain untouched for rollback, and subsequent file edits are ignored. A fork that has no copied goal entries cannot import a legacy parent goal if its parent file is unavailable. New oversized objectives retain their full text in the branch-bound snapshot rather than writing a sidecar.

## Agent Tools

- `create_goal({ objective, recurrences? })` creates a new active goal. The optional nonnegative `recurrences` limit defaults to 2. Objectives are displayed at most 4,000 characters; oversized objectives retain their full text in the session snapshot.
- `update_goal({ status: "complete" })` marks the current goal complete.
- `update_goal({ status: "blocked", reason })` records a repeated blocking condition and its reason.
- `wait_for_goal_input({ question })` waits for an actual user answer without spending automatic follow-ups.
- `get_goal({})` returns the current goal summary.

Statuses are `active`, `waiting_for_user`, `paused`, `blocked`, and `complete`. Pause and resume remain user/system controlled. A delivered interactive/RPC user reply matching an admitted input resumes `waiting_for_user` and resets its follow-up allowance without queuing another prompt. Input source attribution is imperfect: intercepted, modified, or extension-originated messages may not be recognizable as a reply; use `/goal resume` in that case.

## TUI Behavior

When a goal exists, pi shows one compact line above the input: a status marker, goal state (and elapsed work time while active), and a truncated objective. For example: `● Goal 1m · Add CSV export`. Paused, blocked, and achieved goals remain visible until cleared; `/goal clear` removes the widget. The normal footer remains unchanged.

After `/goal <objective>` or `/goal resume`, the extension starts one explicit handoff, then queues **at most two automatic follow-up turns** by default. Set a different nonnegative limit with `/goal --recurrences N <objective>` or `create_goal({ objective, recurrences: N })`; `/goal recurrences N` changes the active goal's limit. `0` disables automatic follow-ups. Each real user message or explicit resume resets the allowance. Once the limit is reached, the goal remains active but waits for user input instead of repeatedly prompting itself; the count survives reloads. Extension-injected prompts do not reset it. Hidden continuation prompts wrap the objective as untrusted user data.

## Blocked goals

Use `update_goal` with `status: "blocked"` only after the same blocking condition has recurred for at least three consecutive goal turns. A resumed goal starts a fresh audit; do not block a goal merely because work is hard, slow, or uncertain.

If an active turn ends with `ctx.signal.aborted`, pi-goal records `user interrupted the turn` and suppresses continuation. A blocked goal stays blocked until the user explicitly `/goal resume`s, replaces, or clears it. Unrelated user prompts and goal-continuation messages do not resume it. Continuation prompts label the objective as untrusted goal data rather than user-provided data, because `create_goal` may store a model-inferred objective. The published extension API exposes no abort source, so this `ctx.signal` heuristic cannot distinguish user-initiated aborts from system aborts and may label a non-user abort as `user interrupted the turn`. Follow-up: upstream an `aborted` flag and abort-source field in the published extension API.

## Development

```bash
bun install
bun run check
bun run test
npm pack --dry-run
```

Consumers that install with npm can still use the lockfile:

```bash
npm ci
npm test
```

The implementation is strict TypeScript and mirrors sibling pi extension metadata, CI, and package layout. `bun run check` runs `tsgo --noEmit`, `biome check .`, and the TypeScript no-excuse checker.

## Related

- [senpi](https://github.com/code-yeongyu/senpi) — the fork/runtime these extensions are extracted from.
- [Ultraworkers Discord](https://discord.gg/PUwSMR9XNk) — community link from the senpi README.
- [Dori](https://sisyphuslabs.ai) — the product powered by senpi under the hood.
