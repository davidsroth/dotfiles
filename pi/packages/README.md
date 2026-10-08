# Local and Vendored Pi Packages

This directory contains homespun Pi packages and intentionally vendored third-party packages.

Current packages (wired into Pi via `settings.base.json`):

- `pi-subagents`

`pi-vim`, `pi-aside`, `pi-intercom`, `pi-qna`, `pi-plan-review`, `pi-memory`,
`pi-session-recall`, `pi-clm`, `pi-codex-compaction` (vendored from
`ogulcancelik/pi-extensions`), and `pi-goal` (vendored from `code-yeongyu/pi-goal`) now live in
their own git repositories; their sources
are listed in the untracked `~/.pi/agent/settings.local.json` under `extraPackages`.
Their history up to the move remains in this repository's log. `pi-intercom-tailnet` (disabled
experiment) was removed; its source is in history before this change.

Previously this directory also held `rpiv-mono` (a third-party Pi pipeline
monorepo, upstream: `juicesharp/rpiv-mono`, plus a personal fork).
It is its own git repo and was never wired into the Pi config, so it now lives
at `~/src/rpiv-mono` instead of nested untracked inside dotfiles.

These packages are loaded by Pi via relative paths declared in the tracked
`pi/.pi/agent/settings.base.json`, which is the canonical package inventory.
`scripts/pi-packages.sh` derives installation, verification, typechecking, and
testing from that list and rejects unconfigured package directories or missing
lockfiles. On install, `install.sh` (or `just pi-settings`)
merges that base with any per-machine `settings.local.json` to generate the live,
gitignored `pi/.pi/agent/settings.json`. Edit the package list in
`settings.base.json`, not the generated `settings.json`.

## Why vendor them?

- reproducible Pi setup across machines
- local patching/customization without depending on external installs
- package versions travel with the dotfiles repo

## Vendoring policy

- **Vendor source, docs, tests, and lockfiles**
- **Do not vendor install artifacts** such as `node_modules/`, `dist/`, `build/`, or caches
- Keep upstream provenance in each package's `VENDORED_FROM.md` when available
- Prefer small, explicit commits for local modifications to vendored packages
- Run `just pi-install` after dependency changes, `just pi-check` for all
  typechecks, and `just pi-test` for every configured package test suite

A local `.gitignore` in this directory excludes common install/build artifacts.

## Updating a vendored package

Recommended workflow:

1. Inspect the package's `VENDORED_FROM.md` and upstream repository
2. Refresh the package source from upstream
3. Keep or regenerate lockfiles as needed
4. Remove any install artifacts before committing
5. Commit the refresh as a dedicated package update commit

## Notes

- `pi-subagents` is the most active/complex vendored package and is the most likely to need compatibility updates as Pi evolves
- Relative package loading assumes the stowed Pi config layout used by this repo
