# ADR 0001 — Target the pi-intercom v0.9.2 broker contract

- **Status:** Accepted (revised for the v0.9.2 core rebase)
- **Date:** 2026-05-31
- **Revised:** 2026-08-05

## Context

The relay connects to the local pi-intercom broker with one control session and
one virtual session for each remote tailnet session. The supported cores are
stock `pi-intercom@0.9.2` and the v0.9.2-based portable aside implementation.
Their broker protocol is the same except for additive aside support; no broker
flavor branch is needed.

The v0.9.2 contract relevant to this package is:

- four-byte big-endian JSON framing with a fixed 1 MiB broker frame limit;
- `register { session, sessionId? }` followed by
  `registered { sessionId, features? }`;
- `list`, `send`, and `unregister` client verbs;
- broker `error` frames and registration limits/timeouts;
- stable caller-selected top-level registration IDs;
- session `features`, including recipient capability `aside-v1`;
- the expanded v0.9.2 message/session metadata.

`registered.features` describes broker capabilities. It is not a protocol or
broker-flavor version. Session `features` independently describes recipient
capabilities.

## Decision

1. The bridge retains a strict, centralized four-verb writer allowlist:
   `register`, `list`, `send`, and `unregister`. Both current brokers are strict
   on unknown verbs. Adding a lifecycle verb must therefore be deliberate and
   tested, not inferred from unknown-verb lenience.
2. `start()` and virtual operations wait for an actual valid `registered`
   response. Error, close, protocol failure, and timeout reject registration and
   all pending list/send operations.
3. The relay sends deterministic top-level `sessionId` values. The control ID is
   derived from the local host; virtual IDs are SHA-256-derived from peer host
   and remote session ID. Reconnects reuse them. An atomic PID-file claim keeps
   duplicate relay processes from replacing each other's registrations.
4. The bridge exposes `brokerFeatures`, not `brokerProtocolVersion`.
5. A virtual session advertises `aside-v1` only when the represented remote
   session advertises it. Aside/reply-error fields otherwise remain additive and
   are forwarded unchanged.
6. Local-broker framing is always limited to 1 MiB. Peer framing uses the same
   wire format but has an independent limit controlled by
   `PI_INTERCOM_TAILNET_MAX_FRAME_BYTES`.
7. Runtime files follow `PI_CODING_AGENT_DIR`. Relative values are resolved
   against the launching process's current directory and passed to the relay as
   absolute paths.

## Consequences

- Stock v0.9.2 and the aside implementation use one code path.
- Stable IDs avoid accumulating ambiguous disconnected mailbox identities.
- The current minimal bridge does not forward v0.9 delivery receipts,
  cancellation controls, or presence updates. Cross-host basic send/ask and
  aside routing are supported; those lifecycle events are explicitly out of
  scope until their broker verbs are deliberately added to the allowlist.
- This package currently supports POSIX/macOS Unix sockets only. Windows named
  pipes and TCP endpoint `stateId` registration are not implemented.

## Verification

Tests use an independently framed v0.9.2-style broker and cover registration
readiness/features, stable IDs, immediate-send ordering, broker errors,
registration timeout, pending-operation close rejection, metadata forwarding,
the strict writer allowlist, path resolution, and the broker 1 MiB boundary.
