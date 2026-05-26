# pi-intercom-tailnet

Extension to [`@davidroth/pi-intercom`](../pi-intercom) that bridges DMs
(and, in the future, channels) across a Tailscale tailnet.

> **Status: Phase 0 spike.** Cross-host DMs only, behind an explicit
> static allowlist. No channels yet, no interactive grant flow,
> minimal UI integration. Treat as a topology proof, not a feature.
>
> Design doc: `tmp/pi-intercom-tailnet-scope.md`.

## What works today

- Per-host **relay daemon** auto-spawned by the pi extension when
  `~/.pi/agent/intercom/tailnet.json` has `enabled: true`.
- Listens on a TCP port (default 4271) bound to the Tailscale IPv4 of
  this host. Refuses to start if no Tailscale IPv4 is detected.
- Accepts inbound connections from peers whose MagicDNS short name
  appears in `allowedHosts`. Everyone else is rejected at the hello.
- Periodically polls `tailscale status --json` to track online peers
  and dial them.
- A remote peer's sessions show up on your local broker as virtual
  sessions named `<remoteName>@<remoteHost>`. The existing `intercom`
  tool routes DMs to them with **no other changes**.

## What doesn't work yet

- **Channels** (`post` / `read` / `tail`). Reserved in the protocol;
  no implementation yet.
- **Interactive grant flow** (§4.2 of the scope doc). Phase 0 uses
  only the static `allowedHosts` list; there is no per-peer or
  per-session approval prompt.
- **Cross-host session list discovery.** A virtual local session for
  `worker@nimbus` is only created when nimbus first DMs you. We have
  not yet implemented "ask nimbus's relay for its session list and
  pre-populate".
- **Reconnect / queue.** If a peer link drops while a DM is in flight,
  the DM is dropped, not retried.

## Install / wire-up

Already loaded via `~/.pi/agent/settings.json` if you add it:

```json
{
  "packages": [
    "../../packages/pi-intercom",
    "../../packages/pi-intercom-tailnet"
  ]
}
```

Then create `~/.pi/agent/intercom/tailnet.json`:

```json
{
  "enabled": true,
  "allowedHosts": ["aurora"]
}
```

Restart pi. The extension spawns the relay; it logs to stderr,
which (because we `stdio: "ignore"`) goes to the bit bucket. To watch
logs while debugging, run the relay manually:

```bash
cd ~/dotfiles/packages/pi-intercom-tailnet
npx tsx relay/relay.ts
```

## Smoke test (two hosts, A and B)

Pre-reqs:

- Both hosts on the same tailnet, both with `tailscale status` working.
- Both hosts have `@davidroth/pi-intercom` + `pi-intercom-tailnet` installed.
- `~/.pi/agent/intercom/tailnet.json` on A lists B in `allowedHosts`,
  and vice versa.

1. On A and B, start a pi session each. Name them: `/name a-planner`
   on A, `/name b-worker` on B.
2. Verify intra-host intercom works: open a second session on A,
   `intercom({ action: "list" })` should show `a-planner`.
3. From A, `intercom({ action: "list" })`. You should *not* yet see
   `b-worker` (no cross-host session-list discovery in Phase 0).
4. From B, send to A's session id (find via local `list` on A and
   pass the id over manually):
   ```ts
   intercom({ action: "send", to: "<A's session UUID>", message: "hi from B" })
   ```
   This won't work yet because B doesn't know A's session id without
   the cross-host list. **This is the Phase 0 limitation:** you need
   to either upgrade to Phase 1's discovery before name-based
   targeting works, or test by manually opening a virtual session
   from the relay.
5. Once Phase 1 lands, the same flow becomes
   `intercom({ action: "send", to: "a-planner@hostA", message: "..." })`.

The Phase 0 spike's "proof" is therefore narrow: relay daemons connect
to each other, exchange hellos, refuse unauthorized hosts. End-to-end
DM delivery without manual session-id juggling requires Phase 1.

## Testing

```bash
cd ~/dotfiles/packages/pi-intercom-tailnet
npm install
npm test
```

Unit tests cover:

- `config.ts` — merge, validation, allowlist semantics.
- `tailscale.ts` — `tailscale status --json` parsing.
- `framing.ts` — length-prefixed JSON roundtrip + partial reads.

Integration tests (relay end-to-end against a real broker) are TODO.
