# Forked from

This package is maintained as `@davidroth/pi-intercom` in David Roth's
dotfiles repository.

## Current upstream base

- Repository: https://github.com/nicobailon/pi-intercom
- Base commit: `63fb02eda4fbb847814d592617c83b3fd5e6cdf7`
- Base release: `pi-intercom@0.9.2`
- Rebased: 2026-08-05
- Selectively synced through upstream commit `006af91` (post-`v0.10.1`): 2026-08-16
- License: MIT

The fork remains structurally based on `v0.9.2`; post-base changes were ported
manually rather than merged wholesale. Integrated upstream commits:

- `c3543d6` (#85), `f260df0` (#88), `25ffb96` (#87), `5d76146` (#90)
- `72309e0` + `fd30948` (#91/#92), `126875e` (#94)
- `2ba9f53` (#100), the `tsx` resolution portion of `c9675a5` (#98), and `006af91` (#103)

Intentionally not integrated: Herdr pane auto-launch (#95), tmux pane presence
(#101), persisted blocking asks (#105), or the broad protocol refactor (#96).

## Branch model

The fork is rebuilt as an ordered stack:

1. upstream `v0.9.2`
2. portable `aside` feature commit, suitable for stock upstream
3. fork-only hardening, presence, and agent-picker commits
4. selected post-`v0.9.2` correctness/reliability ports listed above

This keeps aside independently reviewable/shareable instead of encoding it in
a monolithic vendored diff.

## Fork package

- Package: `@davidroth/pi-intercom@0.10.0`
- Directory: `pi/packages/pi-intercom/`
