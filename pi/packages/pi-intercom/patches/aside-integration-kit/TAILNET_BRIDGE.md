# Tailnet bridge implementation guide

This guide describes behavior, not a required file layout.

## Data flow

For a local caller asking `worker@remote-host`:

1. The remote relay publishes the real worker's `SessionInfo`, including
   `features`.
2. The local relay registers a virtual session representing that worker.
3. The virtual registration includes `aside-v1` only if the real worker did.
4. The local patched core resolves the virtual session and performs its normal
   broker + recipient capability checks.
5. The relay forwards the complete aside message to the remote relay.
6. The remote relay sends it through its local broker to the real worker.
7. The worker's temporary side session answers with `replyTo` set to the
   original message ID.
8. Both relays preserve that reply unchanged on the return path.

## Minimal adaptation

### 1. Extend mirrored types

```ts
const ASIDE_FEATURE = "aside-v1";

type SessionInfo = ExistingSessionInfo & {
  features?: string[];
};

type IntercomMessage = ExistingIntercomMessage & {
  aside?: boolean;
  replyError?: string;
};
```

Do not strip other existing or future optional message fields.

### 2. Carry session capabilities between hosts

Include `features` in full session snapshots and join/update events. Treat the
field as untrusted input and retain only capabilities the bridge supports:

```ts
function bridgeableFeatures(session: SessionInfo): string[] {
  return session.features?.filter((feature) => feature === ASIDE_FEATURE) ?? [];
}
```

A host-level hello capability is not a substitute for the per-session
capability: one host may contain a mix of patched and stock sessions.

### 3. Advertise capabilities on virtual sessions

```ts
const features = bridgeableFeatures(remoteSession);
openVirtualSession({
  stableSessionId: stableId(remoteHost, remoteSession.id),
  name: `${remoteSession.name ?? remoteSession.id}@${remoteHost}`,
  features,
  onMessage: forwardToRemoteHost,
});
```

If a remote session's features change, re-register or update its virtual session
so stale capability data cannot permit an unsafe aside. Use a stable virtual ID
across reconnects.

Wait for the local broker's `registered` response before exposing the virtual
session as ready or sending through it. If available, record
`registered.features` for diagnostics.

### 4. Preserve message correlation

Prefer forwarding the original message object:

```ts
sendTailnetFrame({
  type: "tailnet_dm",
  fromSessionId,
  toSessionId,
  message, // Preserve id, aside, replyTo, replyError, and unknown fields.
});
```

If the wire encoder reconstructs messages, explicitly include at least:

- `id`, `timestamp`, `content`;
- `expectsReply`, `aside`, `replyTo`, `replyError`;
- attachments, sequence/timing metadata, `supersedes`, and `retryOf`.

Never assign a new ID while relaying. Broker reply waiters correlate the answer
using the original `replyTo`.

### 5. Validate without downgrading

Reject malformed `features`, `aside`, and `replyError` fields. Do not clear
`aside: true` when a destination is incapable. The sender-side core should have
prevented that route, but the relay must still avoid changing semantics.

### 6. Optional cancellation support

For full lifecycle support, define a Tailnet control frame such as:

```ts
type TailnetMessageControl = {
  type: "tailnet_message_control";
  fromSessionId: string;
  toSessionId: string;
  action: "cancel";
  messageId: string;
};
```

Authenticate and route it using the same peer/session mapping as the original
message. On the destination host, emit the corresponding local broker
cancellation/control operation. Cancellation is best-effort, but must remain
scoped to the original sender, receiver, and message ID.

## Acceptance tests

A bridge adaptation is complete when automated tests demonstrate:

1. **Capability propagation:** a capable remote session produces a local virtual
   registration with `features: ["aside-v1"]`.
2. **No false advertising:** a stock/unknown remote session produces no aside
   capability.
3. **Capability refresh:** removing the remote capability removes it locally.
4. **Request preservation:** an aside request arrives with the same `id`,
   `expectsReply`, `aside`, text, attachments, and optional metadata.
5. **Reply preservation:** the return message retains the original `replyTo`.
6. **Error preservation:** `replyError` survives the return path.
7. **Mixed-version safety:** a patched caller targeting a stock remote fails
   before delivery; the stock remote receives no normal ask.
8. **Registration ordering:** no virtual send occurs before stable broker
   registration succeeds.
9. **Round trip:** two patched hosts complete an aside without adding the
   question to the recipient's interactive transcript.
10. **Malformed input:** non-boolean `aside`, non-string `replyError`, and
    non-string feature entries are rejected.
11. **Cancellation** (if implemented): cancelling the caller aborts active
    remote side work and cannot cancel another sender's message.

## Reference locations in this repository

- Tailnet wire mirrors: `pi/packages/pi-intercom-tailnet/types.ts`
- Virtual registration: `pi/packages/pi-intercom-tailnet/relay/broker-bridge.ts`
- Capability projection and forwarding:
  `pi/packages/pi-intercom-tailnet/relay/relay.ts`
- Bridge tests: `pi/packages/pi-intercom-tailnet/test/broker-bridge.test.ts`
