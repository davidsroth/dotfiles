# pi-intercom-tailnet

Extension that bridges DMs (and, in the future, channels) across a
Tailscale tailnet by relaying through the **local intercom broker**.

## Broker compatibility

The relay talks to whatever intercom broker your local pi-intercom
extension already started. It is wire-compatible with **both**:

- upstream [`nicobailon/pi-intercom`](https://github.com/nicobailon/pi-intercom)
  (`pi install npm:pi-intercom`), and
- the [`@davidroth/pi-intercom`](../pi-intercom) fork.

It only emits the broker control verbs both implementations understand
(`register` / `list` / `send` / `unregister`) and ignores any
fork-only fields, so no fork adoption or code change is needed to run it
against the upstream broker. See
[`docs/adr/0001-dual-broker-compatibility.md`](docs/adr/0001-dual-broker-compatibility.md)
for the contract and how it's enforced + tested.

> **Status: Phase 1 — cross-host session discovery.** Cross-host DMs
> work with name-based targeting (`worker@maigret`). Behind a static
> allowlist; no interactive grant flow yet. No channels yet.

## What works today

- Per-host **relay daemon** auto-spawned by the pi extension when
  `~/.pi/agent/intercom/tailnet.json` has `enabled: true`.
- Listens on a TCP port (default 4271) bound to the Tailscale IPv4 of
  this host. Refuses to start if no Tailscale IPv4 is detected.
- Accepts inbound connections from peers whose MagicDNS short name
  appears in `allowedHosts`. Everyone else is rejected at the hello.
- Periodically polls `tailscale status --json` to track online peers
  and dial them.
- **Cross-host session discovery:** when a peer link comes up, both
  sides exchange their local session lists. Remote sessions appear on
  your local broker as virtual sessions named `<name>@<host>`.
  Joins/leaves are propagated incrementally.
- The existing `intercom` tool routes DMs to them by **name**
  (`intercom({ action: "send", to: "worker@maigret", message: "hi" })`)
  with **no other changes**.

## What doesn't work yet

- **Channels** (`post` / `read` / `tail`). Reserved in the protocol;
  no implementation yet.
- **Interactive grant flow** (§4.2 of the scope doc). Phase 1 still
  uses only the static `allowedHosts` list; there is no per-peer or
  per-session approval prompt.
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
3. From A, `intercom({ action: "list" })`. You should now see
   `b-worker@B` (cross-host session discovery is active in Phase 1).
4. From A, send by name:
   ```ts
   intercom({ action: "send", to: "b-worker@B", message: "hi from A" })
   ```
5. From B, reply:
   ```ts
   intercom({ action: "send", to: "a-planner@A", message: "hello back" })
   ```

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
