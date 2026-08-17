# Coding-agent prompt

Copy the prompt below and attach this kit plus the target Tailnet-intercom
repository.

---

Implement portable `aside-v1` support in this Tailnet-intercom implementation.
First inspect its broker protocol, remote-session mirroring, virtual-session
registration, message encoding/validation, correlation, and tests. Adapt the
existing architecture rather than replacing it.

Use the attached files as the contract and reference:

- `PROTOCOL.md`
- `TAILNET_BRIDGE.md`
- `aside-v0.9.2.patch` (the complete stock-core implementation)

Requirements:

1. Add the exact capability token `aside-v1`.
2. Preserve optional `SessionInfo.features`, `IntercomMessage.aside`, and
   `IntercomMessage.replyError` across validation and serialization.
3. Propagate per-session capabilities between hosts.
4. Advertise `aside-v1` on a local virtual session only when its represented
   remote session advertised it. Do not infer support from host version,
   package name, or a host-level hello alone.
5. Preserve message `id`, `replyTo`, `aside`, `replyError`, and all existing
   metadata unchanged in both directions.
6. Fail closed. Never downgrade an aside to a normal ask when either broker or
   recipient capability is absent.
7. Keep stable virtual-session IDs and wait for broker registration before
   sending.
8. Validate untrusted fields: string-array `features`, boolean `aside`, string
   `replyError`.
9. If this bridge already transports cancellation/control frames, extend them
   to cancel active aside work by original message ID. If not, document
   cross-host cancellation as a limitation rather than expanding scope
   silently.
10. Add focused tests for capability propagation/removal, no false advertising,
    request/reply/error correlation, mixed patched/stock peers, malformed
    fields, and registration ordering.

Before editing, report the relevant files and a short plan. After editing, run
the narrow tests first, then the repository's full test and typecheck commands.
Summarize exactly what changed, compatibility assumptions, remaining lifecycle
limitations, and validation results. Do not claim stock compatibility unless a
mixed-version test proves an aside cannot silently reach stock as a normal ask.

---
