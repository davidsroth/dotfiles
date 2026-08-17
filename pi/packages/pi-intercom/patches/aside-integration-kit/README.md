# Aside v1 integration kit

This kit is for teams adding out-of-band `aside` questions to pi-intercom or a
Tailnet bridge built around it.

An aside asks a live Pi session a one-off question using a temporary, read-only
fork of that session's context. It must not interrupt the recipient's active
turn or append the question/answer to the recipient's conversation history.

## Contents

- [`aside-v0.9.2.patch`](../aside-v0.9.2.patch): complete core implementation
  based directly on stock `pi-intercom@0.9.2` (`63fb02e`).
- [`PROTOCOL.md`](PROTOCOL.md): wire fields and capability contract.
- [`TAILNET_BRIDGE.md`](TAILNET_BRIDGE.md): implementation recipe and acceptance
  tests for a cross-host relay.
- [`CODING_AGENT_PROMPT.md`](CODING_AGENT_PROMPT.md): ready-to-paste task prompt
  for adapting another implementation.

The stock patch is intentionally separate from David's fork-only agent picker
and broker hardening. It can be applied with `git am`, or used as concrete
source material by a coding agent when the target has diverged.

## Core installation

```bash
git clone https://github.com/nicobailon/pi-intercom.git
cd pi-intercom
git checkout v0.9.2
git am /path/to/aside-v0.9.2.patch
npm ci
npm test
```

For a different pi-intercom version, port the commit rather than forcing the
patch. Preserve the negotiation and no-downgrade behavior described in
`PROTOCOL.md`.

## Tailnet integration in one sentence

Propagate each remote session's `aside-v1` capability onto its local virtual
session, then forward `aside`, `replyError`, `id`, and `replyTo` unchanged in
both directions.

## Safety invariant

Never advertise `aside-v1` for a virtual session unless the represented remote
session advertised it. A patched caller must reject an aside to an incapable or
unknown peer instead of silently converting it to a normal, interrupting ask.

## Known bridge limitation

The reference Tailnet bridge in this repository transports aside request and
reply messages, but does not yet forward cancellation/control frames across the
Tailnet. A cancelled local waiter can therefore leave remote aside work running
until it completes or times out. `TAILNET_BRIDGE.md` describes cancellation as a
recommended follow-up for bridges that already transport lifecycle controls.
