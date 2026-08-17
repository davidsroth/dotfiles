# pi-intercom-tailnet

Extension that bridges pi-intercom DMs across a Tailscale tailnet through each
host's local broker.

> **Status: Phase 1.** Cross-host discovery and DMs work behind a static host
> allowlist. Channels and interactive grants are not implemented.

## Broker compatibility

The relay targets stock `pi-intercom@0.9.2` and `@davidroth/pi-intercom@0.10.x`, including its portable `aside-v1` implementation. It uses the common registration/features protocol;
there is no broker-flavor detection.

The broker writer deliberately permits only `register`, `list`, `send`, and
`unregister`. Cross-host delivery receipts, cancellation controls, and live
presence/name updates are not forwarded yet. See
[`docs/adr/0001-dual-broker-compatibility.md`](docs/adr/0001-dual-broker-compatibility.md).

## What works

- A relay daemon listens on the host's Tailscale IPv4 (port 4271 by default).
- `allowedHosts` and Tailscale `whois` gate inbound peers.
- Remote sessions appear locally as `<name>@<host>` virtual sessions.
- Stable v0.9 registration IDs are reused across broker and peer reconnects.
- Messages preserve v0.9.2 metadata plus `aside` and `replyError`.
- Virtual sessions advertise `aside-v1` only for remote sessions that support it.
- Local-broker frames have the stock fixed 1 MiB limit. Peer framing is
  independently configurable with `PI_INTERCOM_TAILNET_MAX_FRAME_BYTES`.

Peer-link drops are not queued or retried. Channels and interactive grant flow
remain future work.

## Runtime paths and platform support

This package follows `PI_CODING_AGENT_DIR`:

- config: `$PI_CODING_AGENT_DIR/intercom/tailnet.json`
- broker: `$PI_CODING_AGENT_DIR/intercom/broker.sock`
- relay PID: `$PI_CODING_AGENT_DIR/intercom/tailnet-relay.pid`

The default agent directory is `~/.pi/agent`. An absolute configured path is
used directly; a relative path is resolved against the pi launcher's current
working directory and passed to the relay as an absolute path.

The tailnet relay currently supports POSIX/macOS Unix sockets only. Windows
named pipes and opt-in broker TCP endpoints are not implemented.

## Configure

Load `pi-intercom` and this package, then create
`~/.pi/agent/intercom/tailnet.json` (or the corresponding custom agent path):

```json
{
  "enabled": true,
  "allowedHosts": ["aurora"]
}
```

Both hosts must list each other and have working `tailscale status`/`whois`.
After restarting pi, a remote `worker` session on `aurora` appears as
`worker@aurora` and can be targeted with the existing intercom tool:

```ts
intercom({ action: "send", to: "worker@aurora", message: "hi" })
```

For portable aside, both the local sender and represented remote recipient must
advertise `aside-v1`; stock recipients continue to use normal ask behavior when
no aside capability is requested.

## Development

```bash
cd pi/packages/pi-intercom-tailnet
npm install
npm test
npm run typecheck
```

The broker tests use an independently framed v0.9.2-style socket server so
framing drift is not hidden by importing the implementation under test.
