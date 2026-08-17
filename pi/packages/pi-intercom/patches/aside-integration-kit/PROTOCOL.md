# Aside v1 protocol contract

## Capability

The capability token is exactly:

```ts
export const ASIDE_FEATURE = "aside-v1";
```

There are two independent checks:

1. The local broker's `registered.features` must include `aside-v1`.
2. The target `SessionInfo.features` must include `aside-v1`.

The first proves that the broker understands and preserves aside semantics. The
second proves that the recipient will process the request out of band. A sender
must fail closed if either check is missing.

A Tailnet relay must carry `SessionInfo.features` in session list/join frames and
mirror only capabilities actually advertised by the represented remote session
onto the corresponding local virtual-session registration.

## Additive wire fields

These fields extend the existing pi-intercom message/session shapes:

```ts
interface SessionInfo {
  // Existing fields omitted.
  features?: string[];
}

interface IntercomMessage {
  // Existing fields omitted.
  aside?: boolean;
  replyError?: string;
}
```

They are additive. Relays should preserve unknown optional message fields rather
than reconstructing messages from a narrow allowlist.

Validate the known fields at every untrusted boundary:

- `features` is absent or an array of strings;
- `aside` is absent or a boolean;
- `replyError` is absent or a string.

## Request and replies

Aside request:

```json
{
  "id": "question-uuid",
  "timestamp": 1775581200000,
  "expectsReply": true,
  "aside": true,
  "content": { "text": "What invariant does this module maintain?" }
}
```

Successful reply:

```json
{
  "id": "reply-uuid",
  "timestamp": 1775581205000,
  "replyTo": "question-uuid",
  "content": { "text": "It preserves one owner per runtime claim." }
}
```

Failed reply:

```json
{
  "id": "reply-uuid",
  "timestamp": 1775581205000,
  "replyTo": "question-uuid",
  "replyError": "Could not answer the aside: no active model",
  "content": { "text": "Could not answer the aside: no active model" }
}
```

The bridge must not regenerate `id`, `replyTo`, or `replyError`. Existing
sender sequence, receipt timestamps, attachment, retry, and supersede fields
should also pass through unchanged.

## Recipient behavior

On an inbound top-level message where `aside === true` and `replyTo` is absent:

1. acknowledge receipt;
2. do not enqueue or inject it into the interactive session;
3. fork the recipient's current context into a temporary SDK session;
4. expose read-only inspection tools only;
5. answer with a normal message whose `replyTo` is the request ID;
6. set `replyError` when the side session fails;
7. dispose the temporary session.

Limit concurrency and execution time. The stock patch implements both.

## Cancellation

The core patch uses `cancel_message` locally, which produces a
`message_control` action of `cancel` for active recipient work. A minimal
Tailnet adapter may omit cross-host cancellation while still supporting normal
aside completion. A complete adapter should correlate and transport the cancel
control by the original message ID; it must never treat cancellation as a new
message.

## Compatibility matrix

| Local core | Remote core | Virtual advertises `aside-v1` | Result |
|---|---|---:|---|
| patched | patched | yes | Aside round-trip |
| patched | stock | no | Caller rejects before send |
| stock | patched | irrelevant | No aside action in stock caller |
| patched | unknown/disconnected | no | Caller rejects before send |

Silent downgrade to a normal ask is not compatible with `aside-v1`.
