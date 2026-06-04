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

Code reused across extensions lives in `_shared/` (e.g. `_shared/config.ts`,
the layered `defaults < ~/.pi/agent/<file> < <cwd>/.pi/<file>` config loader).

**Why a subdirectory without `index.ts`:** pi's extension discovery only
auto-loads top-level `*.ts`/`*.js` files and subdirectories that contain an
`index.ts`/`index.js` or a `package.json` with a `pi` manifest. A subdir like
`_shared/` with neither is ignored by discovery, so its modules are *not* loaded
as extensions — they're just imported relatively (`import { ... } from
"./_shared/config"`). Do **not** add an `index.ts` to `_shared/`.
