# Native compaction audit — 2026-09-20

## Scope and outcome

Read-only agent review of this package and the relevant installed Pi 0.85.1
implementation, followed by parent-side source review and synthetic local
reproductions. No live provider calls or private session history were used.
This is not an independent external security assessment.

No confirmed exploitable vulnerabilities were established under the existing
trust model: extensions, model configuration, credentials, and local session files
are trusted; conversation and tool content are untrusted. This is not a guarantee
that the implementation is secure.

The timeout change is implemented separately: `timeoutSeconds` defaults to 300,
accepts integers from 1 through 3600, and applies one deadline across remote
requests, stream consumption, and retry backoff. Trusted project configuration can
override global configuration. Validation: 121 tests passed, TypeScript passed,
and the installed Pi 0.85.1 extension loader loaded the updated package.

## Open correctness findings

These pre-existing findings are **not fixed by the timeout change**.

### Medium: completed streams still wait for EOF

`native-compaction.ts`, `parseSseResponse`: a `response.completed` or
`response.done` event sets a flag, but the reader loop continues until EOF.

Reproduced with a synthetic stream delivering one valid checkpoint and a
completion event while remaining open. The operation timed out rather than
succeeding; cancellation released the reader. A longer deadline only postpones
this failure. This does not establish the cause of the user's reported timeout.

Recommended fix: stop consuming after a terminal event, validate exactly one
nonempty checkpoint, and cancel/release the reader. Cover open-stream success,
missing/invalid checkpoints, and caller-abort races.

### Medium: resolved authentication endpoint is ignored

`index.ts`, `createNativeCheckpoint`: the URL is derived from `model.baseUrl`,
not `auth.baseUrl ?? model.baseUrl`. Pi's normal request path honors the
endpoint returned by authentication resolution.

Reproduced with distinct synthetic model/auth endpoints and mocked fetch: the
model endpoint received the request. This can misroute credentials/history when
an auth endpoint override is configured. No attacker-controlled endpoint was
established.

Recommended fix: match Pi's endpoint precedence and test both override and fallback.

### Low: zero-budget text truncation retains the entire part

`native-compaction.ts`, `truncateMiddle`: `text.slice(-0)` returns the full text.
Proportional allocations in `truncateMessage` can give individual parts zero
characters.

Reproduced with a one-token/four-character budget and multipart user text: five
characters were retained. More zero-allocated parts can worsen the overrun.

Recommended fix: return an empty string for nonpositive character budgets before
handling the one-character case; test multipart budget boundaries.

## Integration and security limitations

- **Context privacy filters:** uncached history and newly finalized tails are
  locally converted without running extension context filters. A deployment
  relying on those hooks for redaction could send unredacted history both after
  resume and during mid-run compaction of newly completed tool results. Cached
  prefix reuse does not cover those tails. No deployed redaction filter was
  established by this audit; compatibility needs synthetic-secret integration
  tests before it can be claimed.
- **Authentication cancellation:** authentication resolution precedes the transport
  deadline and receives no compaction signal. A stalled refresh is not bounded by
  `timeoutSeconds`; transport cancellation tests do not validate this phase.
- **Checkpoint identity:** checkpoints bind provider/API/model ID, not endpoint or
  credential account. Endpoint/account changes require operational isolation.
- **Opaque state:** local checks validate structure and nonempty encrypted content,
  not cryptographic integrity or semantic compaction quality; these depend on the
  provider.
