# pi-aside

Read-only side conversations without interrupting Pi's main agent.

```
/aside Why did we choose this approach?
/aside clear
```

Each `/aside <question>` starts an in-memory conversation seeded with a fresh,
deep-cloned snapshot of the main session's finalized context, including
compaction summaries, plus its current system prompt, model, thinking level,
authentication runtime, and working directory. The side agent has only built-in
`read`, `ls`, `find`, and `grep` tools. It answers in a Markdown panel above the
editor, streaming text without taking focus or showing reasoning.

## Follow-ups

- With an aside open and the main prompt **empty**, press **Up Arrow** to reveal
  and focus an inset reply bar inside the panel. Otherwise Up retains its normal
  editing/history behavior. Dialogs and overlays keep their own keys.
- **Enter** sends only to the aside, keeping the bar open. While it is answering,
  you can type and submit another question; follow-ups run in FIFO order.
- **Esc**, **Ctrl+C**, or **Down Arrow** hides the bar and returns to the unchanged
  main editor. An unsent aside draft is preserved when you reopen the bar.
- Follow-ups retain previous aside exchanges and tool results, but do **not**
  refresh the original main-session snapshot. The panel shows the latest exchange,
  not the whole conversation. The main agent can keep working throughout.

A new `/aside <question>` cancels and replaces the entire conversation.
`/aside clear` cancels and dismisses it. Reload, shutdown, session replacement,
and tree navigation also clear it. Each active turn has a five-minute deadline,
including initial session creation; queued turns start their deadline when active.
Cancellation or timeout discards queued work; start a new `/aside` after a timeout.

There are no saved threads, model settings, tangent mode, injection,
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
  registry bridge. Input focus uses the renderers' public `getFocusedComponent()`
  method, which is absent from their common `TUI` interface; if unavailable,
  Up-arrow activation is disabled rather than stealing input.
- Development dependencies pin Pi 0.85.1. Recheck SDK and focus compatibility
  on upgrades; the installed Pi 1.0.2 extension loader is also checked.

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

Tests include a real SDK conversation with a scripted, credential-free provider
and a real filesystem read, real regular/fullscreen TUI focus/input routing, and
cancellation/race, context isolation, queue ordering, draft, and narrow-width
panel rendering tests. They do not contact a hosted model.

## Prior art

The in-memory context-fork pattern is adapted from this repository's
`pi-intercom/side-session.ts` and `pi-subagents/src/side-session.ts` (MIT).
This is a standalone local package, not a fork of the old BTW overlay UI, and
imports neither package. The former vendored BTW plugin was removed.
