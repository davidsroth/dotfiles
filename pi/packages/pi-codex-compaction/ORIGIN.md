# Upstream provenance

- Repository: https://github.com/ogulcancelik/pi-extensions
- Path: `packages/pi-codex-compaction`
- Revision: `35bbe0f758cec48e5bff9624466d72eb316e9061`
- Upstream version: `@ogulcancelik/pi-codex-compaction` 0.1.5
- License: MIT; original `LICENSE` preserved.

## Local changes

- Vitest, strict TypeScript, locked development dependencies, SDK integration
  coverage, and an opt-in synthetic live smoke test.
- Block incompatible providers/models before continuing or replacing an opaque
  checkpoint with a text summary.
- Persist a non-message compaction boundary so Pi does not retain a duplicate
  text tail; replay using the real provider payload, not a rebuilt session tail.
- Reuse observed transformed provider input for subsequent compaction and reject
  concurrent context changes before installing the checkpoint.
- Reject unsupported custom summary instructions and unfiltered local markers.
- Bound transport time/retries, honor cancellation races, release SSE readers,
  validate nonempty encrypted state, and omit HTTP error bodies from diagnostics.
- Preserve the upstream compatibility fallback for Pi before 0.84.4, but this
  local package is qualified only on Pi 0.85.1.

Review local changes before updating upstream. Do not replace the local package
with the npm release without rechecking these guards and replay tests.
