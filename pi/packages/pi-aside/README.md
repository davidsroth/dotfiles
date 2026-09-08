# pi-aside

Minimal one-shot side questions without interrupting Pi's main agent.

```
/aside Why did we choose this approach?
/aside clear
```

Each question gets a fresh, deep-cloned snapshot of the main session's finalized
context, including compaction summaries, plus its current system prompt, model,
thinking level, authentication runtime, and working directory. The side agent
has only built-in `read`, `ls`, `find`, and `grep` tools. It answers in a Markdown
panel above the editor, streaming text without taking focus or showing reasoning.

A new question cancels and replaces the previous request. `/aside clear` cancels
and dismisses it. Reload, shutdown, session replacement, and tree navigation also
clear it. Requests have a five-minute deadline, including session creation.

There are no follow-ups, saved threads, model settings, tangent mode, injection,
agent-facing tools, or main-session history writes. Bare `/aside` shows usage.
Requires Pi's terminal UI; RPC/print/JSON mode requests fail without starting a
side session. No other extension or MCP tools are loaded in the side session.

## Boundaries

- A snapshot excludes unfinished text and tool results not yet finalized. It is
  not a live view, nor does it reproduce parent extension context/payload hooks.
- Read-only tools are **not a filesystem sandbox**: they can read files accessible
  to Pi, and parent extension-based permission guards are not loaded.
- Answers are requested to be short. The panel renders the answer, not a separate
  scrollable chat. Long answers take up more terminal space.
- Nothing is saved by this extension; provider-side logging/billing still applies.
  Side-request usage is not added to the main session's totals.
- Pi currently exposes its model runtime to extensions only through an internal
  registry bridge. This package targets and tests Pi 0.85.1; recheck on upgrades.

## Installation and development

This repo's `pi/.pi/agent/settings.base.json` includes the local package path.
Run `just pi-settings` after changing the inventory, then `/reload` in the Pi
session that should pick up the change. No runtime npm dependencies beyond Pi's
bundled peer packages.

```
npm ci --ignore-scripts
npm test
npm run typecheck
```

Tests include a real SDK session with a scripted, credential-free provider and a
real filesystem read, alongside cancellation/race, context isolation, and panel
rendering tests. They do not contact a hosted model.

## Prior art

The in-memory context-fork pattern is adapted from this repository's
`pi-intercom/side-session.ts` and `pi-subagents/src/side-session.ts` (MIT).
This is a standalone local package, not a fork of the old BTW overlay UI, and
imports neither package. The former vendored BTW plugin was removed.
