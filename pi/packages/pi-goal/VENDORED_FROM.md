# Upstream provenance

- Source: https://github.com/code-yeongyu/pi-goal
- Vendored commit: `c2e1e732fa12eec1da2a47170c59dfa61fc547c9`
- Vendored on: 2026-09-24
- License: MIT; see `LICENSE`.
- Scope: upstream source, tests, documentation, package manifests and lockfiles, excluding the upstream `.git` directory and GitHub CI configuration.

Local customizations: the goal indicator is a compact above-editor widget instead of a footer status, and automatic follow-ups default to two per user-input cycle with a configurable `/goal` recurrence limit.

This is a vendored copy loaded as a local package from `pi/.pi/agent/settings.base.json`, not a GitHub fork. To refresh it, compare the recorded commit with a new upstream revision, update the source in a separate change, and preserve local modifications. The npm package named `pi-goal` currently belongs to a different repository (`Michaelliv/pi-goal`); do not use `pi install npm:pi-goal` to install this source.
