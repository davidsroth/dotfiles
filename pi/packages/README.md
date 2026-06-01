# Vendored Pi Packages

This directory contains Pi packages that are intentionally vendored into the dotfiles repo.

Current packages (wired into Pi via `settings.base.json`):

- `pi-vim`
- `pi-subagents`
- `pi-btw`
- `@davidroth/pi-intercom` (directory: `pi-intercom`)
- `pi-intercom-tailnet`
- `pi-memory`
- `pi-qna`
- `pi-plan-review`

Also vendored, but **not** wired into the active Pi config:

- `rpiv-mono` — a third-party Pi pipeline monorepo (upstream: `juicesharp/rpiv-mono`),
  kept here for reference. Not referenced by `settings.base.json`.

These packages are loaded by Pi via relative paths declared in the tracked
`pi/.pi/agent/settings.base.json`. On install, `install.sh` (or `just pi-settings`)
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
- `pi-qna` and `pi-plan-review` are local packages extracted from this dotfiles config for easier sharing with coworkers
- Relative package loading assumes the stowed Pi config layout used by this repo
