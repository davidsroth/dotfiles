# pi extensions

Hand-written pi extensions, auto-discovered by pi from `~/.pi/agent/extensions/`
(this dir is stowed there as a folded symlink).

## Typechecking

There is no runtime build step — pi loads each `*.ts` directly via `jiti`. To
catch type errors before they hit a live session:

```sh
just pi-check        # alias: just pic
```

`scripts/pi-typecheck.sh` builds a **gitignored** `node_modules/` symlink farm
pointing at the *currently installed* pi SDK (`@earendil-works/pi-coding-agent`
and its bundled `pi-tui` / `pi-ai` / `pi-agent-core` / `typebox`), then runs
`tsc --noEmit` (see `tsconfig.json`). This pins the typecheck to the exact
version pi runs — no version drift, no SDK download.

This is purely build-time: at runtime, `jiti` aliases the `@earendil-works/*`
and `typebox` specifiers to pi's own bundled copies, so the local `node_modules`
never shadows the SDK.

## Shared helpers (`_shared/`)

Code reused across extensions lives in `_shared/`:

- `_shared/config.ts` — the layered `defaults < ~/.pi/agent/<file> <
  <cwd>/.pi/<file>` config loader.
- `_shared/tui.ts` — terminal rendering helpers (e.g. `padRight`).

**Why a subdirectory without `index.ts`:** pi's extension discovery only
auto-loads top-level `*.ts`/`*.js` files and subdirectories that contain an
`index.ts`/`index.js` or a `package.json` with a `pi` manifest. A subdir like
`_shared/` with neither is ignored by discovery, so its modules are *not* loaded
as extensions — they're just imported relatively (`import { ... } from
"./_shared/config"`). Do **not** add an `index.ts` to `_shared/`.

## Multi-file extensions (directory layout)

A larger extension is a subdirectory with an `index.ts` entry point (which pi
discovers and loads) plus sibling helper modules it imports. `name-header/` is
the reference example:

- `index.ts`  — entry point: the default factory, mutable widget state, refresh
  lifecycle, and pi event/command/shortcut wiring (orchestration only).
- `config.ts` — constants + env overrides.
- `types.ts`  — data shapes.
- `data.ts`   — IO layer (shells out to weather / calendar / `gh`).
- `render.ts` — pure presentation helpers (theme + state → lines).
- `pr-picker.ts` — the PR picker overlay as a self-contained `Component` class
  (mirrors pi-intercom's `AgentPickerOverlay`); the orchestrator injects data
  + callbacks and wires the instance's `requestRender()` / `close()`.

`slack-mcp/` is a second example (an MCP bridge rather than a widget):
`index.ts` orchestrates pi tool/command wiring; siblings split out `types`,
`constants`, `config`, `identity`, `postprocess`, `process-tracker`,
`mcp-client` (the `StdioMCPClient`), `registry` (cross-session shared client),
and `tool-helpers`. Non-`.ts` files (e.g. `slack-mcp.example.json`) can live in
the directory too — discovery ignores them.

Keep only `index.ts` as an entry point — sibling `*.ts` files are imported, not
discovered (discovery does not recurse past the directory's entry point).
