# Native Codex compaction

Vendored and locally hardened from `@ogulcancelik/pi-codex-compaction` 0.1.5;
see [ORIGIN.md](ORIGIN.md). SDK lifecycle tests pass with Pi 0.85.1 and 0.87.1
using synthetic data and mocked HTTP.

## Behavior

- Only `openai-codex` models using `openai-codex-responses` use native remote
  compaction. Other providers retain Pi text compaction on ordinary branches.
- Pi owns manual `/compact`, automatic threshold checks, and overflow recovery.
  Existing `compaction.enabled` and `reserveTokens` settings are unchanged.
- The Codex Responses request uses `remote_compaction_v2` and a trailing
  `compaction_trigger`. The encrypted result is persisted in
  `CompactionEntry.details`, alongside retained recent user input (up to the
  upstream approximate 64k text-token budget).
- Native compaction covers the entire current history, not just Pi's older
  message prefix. `keepRecentTokens` still affects Pi's preparation but does
  not retain a duplicate plaintext tail after the native checkpoint.
- A local summary marker satisfies Pi's session format; it is removed before
  requests. Subsequent requests prepend the native history to Pi's **actual
  serialized outgoing tail**, preserving new messages and context transforms.
- Interactive sessions show running/completed/failed markers. Network/stream
  retries are bounded to three attempts and a configurable overall deadline
  (300 seconds by default), shared across requests, streaming, and backoff.
- Failures cancel compaction without replacing history or silently falling back
  to text summarization. Messages arriving during compaction cancel the attempt
  rather than being discarded.

## Model switching and recovery

A native checkpoint is bound to the **exact provider/API/model ID** that created
it. Incompatible model/provider requests and text compaction of that branch are
blocked. Switch back to that model, or use `/tree` to navigate/fork **before** the
checkpoint, or start a new session with an explicit handoff.

Resume and forks containing the checkpoint require this extension. Do not disable
it and continue a natively compacted branch: stock Pi cannot interpret the opaque
state. Original messages remain in the JSONL history.

`/markup compaction` can show only the local marker, not the encrypted contents.
`/compact <instructions>` is rejected explicitly; use `/compact` without a prompt.
Normal tree text summaries, text-only inherited subagent context, and side sessions
that omit this extension are not portable representations of native checkpoints.
Use an explicit handoff when those workflows need the compacted history.

## Configuration and activation

The local package is listed in `pi/.pi/agent/settings.base.json`. Run
`just pi-settings` after changing the list. Existing sessions need `/reload` or
restart. No model defaults, global thresholds, or other providers are changed.

Set the remote-compaction deadline in `~/.pi/agent/pi-codex-compaction.json`
(or `$PI_CODING_AGENT_DIR/pi-codex-compaction.json` when using a custom agent directory):

```json
{
  "timeoutSeconds": 300
}
```

`timeoutSeconds` must be a whole number from 1 to 3600. Missing or invalid values
fall back to the inherited value, then the 300-second default. A trusted project's
`.pi/pi-codex-compaction.json` overrides individual global fields; untrusted
project configuration is ignored. Configuration is reread for each compaction,
so later value changes do not require reload. The initial code update does.

This deadline bounds the remote transport, not preceding authentication or local
request preparation. Escape still cancels promptly. Increasing it allows slow
compactions more time but cannot fix a stalled connection. Pi's general
`retry.provider.timeoutMs` setting does not control this extension's transport.
The existing `autoCompact` and `thresholdRatio` fields apply only to the legacy
compatibility fallback (Pi before 0.84.4).

## Validation

```sh
npm test
npm run typecheck
# Also exercise the installed host instead of the older devDependency SDK:
PI_CODEX_TEST_HOST="$(npm root -g)/@earendil-works/pi-coding-agent" npm run test:host
# Opt-in: real API calls with synthetic data only; requires Codex authentication.
node live-smoke.mjs <codex-model-id>
```

The installed-host lane aliases SDK imports to that installation (including its
Pi AI/TUI dependencies), without replacing local dependencies. It covers persisted
resume, repeated compaction, tool continuation, and context transformations. Pi
0.87+ projects a system checkpoint before the compaction summary; retained-prefix
matching anchors at the summary rather than assuming it is message zero. Older
checkpoints without a system message remain supported. Structurally mismatched
retained history still blocks the request.

The live smoke test uses a disposable session with no workspace context or tools.
It compacts twice, reopens persisted checkpoints, and verifies an assistant-only
fact survives both times without appearing in plaintext request history. It is a
protocol/continuity check, not a compaction-quality benchmark.

## Integration boundaries

Compaction reuses the latest observed provider input and converts only newly
finalized messages. Before any observed request (e.g. immediately after resume),
it reconstructs input from the active branch using the upstream Codex converter.
Pi does not expose a finalized payload in `session_before_compact`; extensions
that depend on per-request context transforms should make a normal request before
manual compaction after resume. Place this package after payload-transforming
extensions; later payload rewrites can still be order-dependent.

Opaque checkpoints are sent only to compatible Codex requests. They and retained
user input are persisted locally as session data; treat session files as private.
