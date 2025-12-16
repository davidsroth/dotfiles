## Dotfiles Maintenance Report (Pass 2)

Report Date: 2025-08-27

## Summary

- Found two stowable items that should not be stowed: `.codex/` and `.nvimlog`.
- Adjusted `.stow-local-ignore` to exclude `.codex` entirely and any stray `.nvimlog`.
- Added `.nvimlog` to `.gitignore` and removed accidental log file from the repo.
- Added `just audit` task to run syntax checks, JSON validation, broken symlink scan, and stow conflict preview.
- Re-ran checks: clean state; JSON files valid; no broken symlinks; only third‑party plugin scripts lack shebangs (expected).

## Changes

- `.stow-local-ignore`: ignore `.codex` (repo automation), ignore `.nvimlog` (transient log).
- `.gitignore`: added `.nvimlog` under Logs.
- Removed `./.nvimlog` from the repository.
- `justfile`: new `audit` recipe bundling common checks.
- `README.md`: Maintenance section now mentions `just audit`.

## Verification

- `just doctor`: no pending stow links; environment snapshot OK.
- `just audit`:
  - bash/zsh syntax: all OK
  - JSON: all OK via `jq -e`
  - Broken symlinks: none
  - Stow conflicts: none

## Follow-ups

- Optional: add shellcheck/markdownlint recipes if those tools are installed.
- Optional: validate external links in docs when network access is available.
