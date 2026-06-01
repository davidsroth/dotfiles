# ADR 0001 — `pi-intercom-tailnet` must run against both the upstream and `@davidroth` brokers

- **Status:** Accepted
- **Date:** 2026-05-31
- **Deciders:** David Roth (+ review by the `pi-intercom-remote` author)
- **Supersedes:** —
- **Related:** `ORIGIN.md`, `tmp/pi-intercom-tailnet-scope.md` (§1, §3 Option A),
  upstream [`nicobailon/pi-intercom`](https://github.com/nicobailon/pi-intercom)
  (`pi-intercom@0.6.0`), fork `@davidroth/pi-intercom@0.7.0`

## Context

`pi-intercom-tailnet` is a per-host relay daemon that bridges DMs across a
Tailscale tailnet. It does **not** talk to pi sessions directly — it talks to
the **local intercom broker** over that broker's Unix-domain-socket control
protocol (`relay/broker-bridge.ts`): one control connection that consumes
`session_joined` / `session_left` / `sessions`, plus one "virtual session"
connection per remote session, which `register`s a `name@host` row and relays
`send` / `message` / `delivered` / `delivery_failed`.

That broker can be one of (at least) two implementations:

1. **Upstream** `nicobailon/pi-intercom` (`pi-intercom@0.6.0`) — what a coworker
   who installed `pi install npm:pi-intercom` is running.
2. **Fork** `@davidroth/pi-intercom@0.7.0` — vendored in this dotfiles repo;
   what the package was originally designed against (see `ORIGIN.md`).

We want one tailnet relay that works unmodified against **either** broker, so
the package can be shared without forcing adoption of the fork.

### What the brokers actually share (audited 2026-05-31)

The control protocol the bridge depends on is, today, a stable shared subset:

| Surface | Upstream `0.6.0` | Fork `0.7.0` | Bridge depends on |
| --- | --- | --- | --- |
| Framing | 4-byte BE length + JSON, 16 MiB cap | identical | identical |
| Socket path | `~/.pi/agent/intercom/broker.sock` (win32 named pipe) | identical | identical |
| Handshake | none — first frame must be `register` | identical | matches |
| `register {session}` → `registered {sessionId}` | yes | yes (+`version`) | yes |
| `list {requestId}` → `sessions {requestId, sessions}` | yes | yes | yes |
| `send {to, message}` → `delivered {messageId}` | yes | yes (+`recipientId`) | yes |
| … → `delivery_failed {messageId, reason}` | yes | yes | yes |
| inbound `message {from, message}` | yes | yes | yes |
| `unregister` | yes | yes | yes |
| `session_joined {session}` / `session_left {sessionId}` | yes | yes | yes |
| register validation (`isSessionRegistration`) | name?,cwd,model,pid,startedAt,lastActivity,status? | identical (+ optional `originSessionId`) | payload valid for both |

So the relay is **already wire-compatible with both brokers**. The risk is not a
present-day break; it is *silent regression* — a future tailnet feature that
quietly depends on a fork-only behavior.

### The two divergences that matter

1. **Unknown client message types are handled differently.**
   - Upstream `throw`s `Unknown client message type`. The throw propagates through
     `createMessageReader`'s `onMessage` → `onError` → `socket.destroy()`, i.e.
     **upstream drops the entire connection** (control or a virtual session).
   - The fork **logs and ignores** the unknown type, keeping the connection.

   The bridge today only ever emits `register` / `list` / `send` / `unregister`,
   all understood by both. But "the fork tolerates unknown frames" is a trap: any
   new verb added against the fork would appear to work, then silently kill
   connections on upstream.

2. **The fork adds fields the baseline lacks** (`version` on `registered`,
   `recipientId` on `delivered`, optional `originSessionId` on registration). The
   bridge ignores unknown fields, so these are safe — and `version` is in fact a
   useful, backward-compatible **flavor signal**.

## Decision

1. **Target the intersection.** The bridge MUST restrict the client message types
   it emits to the set understood by **both** brokers:
   `register`, `list`, `send`, `unregister`. This set is named and centralized as
   `SHARED_BROKER_CLIENT_MESSAGE_TYPES` in `broker-bridge.ts`; every outbound
   frame goes through one writer that asserts membership, so adding a verb is a
   deliberate, reviewable act rather than an accident.

2. **Tolerate, never require, additive frames.** The bridge MUST ignore unknown
   inbound frame types and unknown fields on known frames (it already does). It
   MUST NOT depend on any field the upstream broker does not send.

3. **Detect the broker flavor from `registered.version`, don't probe.** The
   control connection records `brokerProtocolVersion` from the `registered`
   frame: a number ⇒ fork (or any version-advertising broker); `null` ⇒ baseline
   upstream. Any *future* feature that needs fork-only behavior MUST gate on this
   signal and fall back to the shared subset when it is `null`. No new feature may
   become load-bearing for basic DM delivery.

4. **Never feature-gate on the negative.** Treat an absent/`null` version as
   "baseline, fully functional," not "degraded." DM delivery, discovery, and
   ack/reply correlation must work identically on both.

## Consequences

**Positive**
- One artifact runs against `npm:pi-intercom` and `@davidroth/pi-intercom`
  unchanged; the coworker needs neither the fork nor a code change.
- The compatibility contract is explicit and enforced in code + tests, so a
  future verb can't silently regress upstream by relying on the fork's lenience.
- `brokerProtocolVersion` gives a clean, additive seam for later fork-only
  optimizations (e.g. opting into `originSessionId` supersede-on-reconnect)
  without branching the transport.

**Negative / trade-offs**
- Fork-only niceties are unavailable on baseline by design — notably the
  `originSessionId` supersede-on-reconnect cleanup. On both brokers, stale
  virtual-session rows are reclaimed on socket `close`; we accept that and do not
  emit `originSessionId` in Phase 1.
- The relay can't *spawn* a broker (neither the fork's locking dance nor a plain
  listen) — it only connects to whatever broker the local pi-intercom extension
  started. Out of scope here; the relay already assumes a running broker.

## Compliance / how this is verified

- `SHARED_BROKER_CLIENT_MESSAGE_TYPES` is the single source of truth and the only
  set the bridge's writer will emit; `test/broker-bridge.test.ts` asserts the
  bridge emits nothing outside it across register / list / send / unregister.
- A mock broker is exercised in **two flavors**: *strict* (upstream-style: drops
  the connection on any unknown verb) and *lenient+versioned* (fork-style:
  ignores unknown verbs, sends `version` + `recipientId`). The bridge must
  resolve `sessionId`, route a DM, observe `delivered`, and survive against both.
- The strict mock proves the relay never trips upstream's drop-on-unknown path;
  the versioned mock proves `brokerProtocolVersion` is captured and that extra
  fields are ignored.

## Revisit when

- Channels (`post` / `read` / `tail`, scope doc §7) land — they add new verbs and
  MUST either be in the shared subset (preferred) or be gated behind
  `brokerProtocolVersion` with a baseline fallback, and upstream's
  drop-on-unknown behavior re-verified.
- Either broker changes framing, socket path, or the register handshake.
