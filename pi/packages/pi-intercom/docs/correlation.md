# Intercom ask/reply correlation — design plan

**Status:** Proposed — not yet implemented
**Owner:** David Roth
**Created:** 2026-05-31
**Trigger:** Multiple pending asks from the same sender cannot be replied to
(the `reply` action and `ReplyTracker.resolveReplyTarget` can't disambiguate
two asks that share a sender id/name). Investigation showed this is one symptom
of a broader smell: the correlation layer keys off sender identity and turn
position instead of the unique question id that already exists on the wire.

---

## 1. Current architecture (read-only audit)

Ask/reply state lives in **four hand-synchronized structures** spanning two
files. File references are relative to `pi/packages/pi-intercom/`.

| Concern | Structure | Where |
|---|---|---|
| Outbound: "I asked, I'm blocking for the reply" | `replyWaiter` — a single nullable slot | `index.ts:453-510` |
| Inbound: "I received asks, which one do I reply to" | `ReplyTracker.pendingAsks` — `Map<messageId, ctx>` | `reply-tracker.ts:52,64-69` |
| Inbound: "which message triggered this turn" | `pendingTurnContexts` + `currentTurnContext` (FIFO) | `reply-tracker.ts:53-54,71-84` |
| Delivery gating while busy | `pendingIdleMessages` (FIFO, capped) | `index.ts` |

### 1.1 The one true key already exists

Every `ask` / `aside` / `contact_supervisor` mints a `questionId =
randomUUID()` and sends it as the message's `id`; the reply carries it back as
`replyTo` (`index.ts:1772,1801` and `:1344,1383`). The questionId is **globally
unique** and is the natural correlation key.

But almost nothing keys off it directly:

- **Outbound** (`replyResolvesWaiter`, `reply-tracker.ts:38-50`) matches on a
  **composite**: sender (`name` OR full `id` OR broker-resolved `recipientId`)
  AND `replyTo`. The sender half is the only reason `recipientId` exists — and
  the only reason short-id/name addressing ever failed to correlate (the
  `replyResolvesWaiter` regression fixed earlier this cycle).
- **Inbound** (`resolveReplyTarget`, `reply-tracker.ts:92-127`) selects by
  `currentTurnContext`, then single-pending, then **sender** (`to`, matched by
  id or name in `matchesPendingSender`, `reply-tracker.ts:53-58`). It **never
  looks at `replyTo`**, and the `reply` tool branch (`index.ts`) doesn't pass it
  even though the `intercom` tool schema accepts `replyTo` and `pending` prints
  message ids.

### 1.2 The outbound slot is single-occupancy

`waitForReply` throws `"Already waiting for a reply"` when `replyWaiter` is set
(`index.ts:468`). `ask`, `aside`, and `contact_supervisor` (need_decision /
interview) all funnel through it. So at most one outbound wait exists per
session at a time.

---

## 2. Sharp edges (observed)

| # | Symptom | Mechanism | Severity |
|---|---------|-----------|----------|
| 1 | Two pending asks from the **same sender** can't be replied to; the error tells you to "use the sender session ID" but the id matches both | `resolveReplyTarget` ignores `replyTo`; `matchesPendingSender` matches all same-sender asks | High |
| 2 | Explicit `to` is **silently ignored** during a triggered turn (reply lands on the triggering message, not `to`) | `resolveReplyTarget` returns `currentTurnContext` unconditionally before checking `to` (`reply-tracker.ts:96-98`) | Medium |
| 3 | A queued turn-context can bind to an **unrelated user turn** | `beginTurn` runs on every `turn_start`, including user-initiated turns (`index.ts` turn_start hook) | Medium |
| 4 | A `followUp` ask never becomes a turn-context, so a 2nd same-sender ask is only reachable via the broken `to` path | only the batch's first "trigger" message calls `queueTurnContext` (`index.ts sendIncomingMessage`) | Medium |
| 5 | Parallel `ask`s (same tool batch) — the 2nd fails with "Already waiting" | single `replyWaiter` slot | Medium |
| 6 | Can't `ask` while answering an `aside`, or run `ask` + `contact_supervisor` concurrently | all share the single slot | Medium |
| 7 | Asymmetric concurrency: a session can **answer** many asides (`activeAsides` Set) but **ask** only one | answerer uses per-aside controllers; asker uses the single slot | Low |
| 8 | Addressing fragility (name vs full id vs `recipientId`) and its past bug | sender used as correlation key instead of `questionId` | Medium |
| 9 | Asker timeout/cancel leaves the answerer's `pendingAsks` entry; a late reply arrives at the asker as a **stray inbound message** | `session_left` cancels only the asker's `replyWaiter`; nothing prunes the answerer's `pendingAsks`; late reply finds `replyWaiter` null and falls through to normal delivery (`index.ts:766`) | Low |

---

## 3. Root cause

Correlation is done with **sender identity + turn position** as keys, layered
on top of a payload that already carries a unique `questionId`. Every edge in
§2 except the lifecycle ones (#9) traces to this: the single slot, the
same-sender ambiguity, the `to`-vs-context precedence, and the addressing
fragility are all "we didn't key on the unique id."

---

## 4. Proposed design — unify on the question id

### 4.1 Outbound: `Map<questionId, Waiter>`

Replace the single `replyWaiter` with:

```ts
interface ReplyWaiter {
  questionId: string;          // === the ask message id; the correlation key
  expectedSenderId?: string;   // broker-resolved recipient id, if known
  expectedSenderName?: string; // raw target string (name or id/prefix typed)
  resolve(message: Message): void;
  reject(error: Error): void;
}
const replyWaiters = new Map<string, ReplyWaiter>();
```

- **Correlation is `replyWaiters.get(message.replyTo)`** — O(1), unambiguous.
- The sender fields become a **security assertion**, not the key: when a reply
  arrives for a known questionId, optionally verify `from` matches the
  addressee we sent that questionId to; reject (and keep waiting) on mismatch.
  This is defense against a confused/malicious peer replying to a questionId it
  was not the target of. It is no longer load-bearing for correctness, so the
  name/short-id/`recipientId` matching that caused past bugs is retired from the
  correctness path.
- Removes edges #5, #6, #7, #8. `waitForReply` no longer throws "Already
  waiting"; multiple concurrent asks/asides/contact_supervisor calls each get
  their own entry.
- `session_shutdown` rejects **all** waiters; `disconnected` rejects all;
  `session_left` rejects only waiters whose `expectedSenderId`/name matches the
  departed session.

### 4.2 Inbound: `replyTo` is the primary selector

`resolveReplyTarget({ to?, replyTo? })`:

1. If `replyTo` is given and matches a `pendingAsks` entry → return it. (New,
   primary. Fixes #1: `pending` prints the id; `reply({ replyTo })` targets it.)
2. Else if `to` is given → filter by sender; exactly one match wins; >1 → error
   that now names message-id disambiguation; 0 with multiple pending → error.
3. Else if `currentTurnContext` is set → return it (the no-args convenience for
   the reply-hint flow).
4. Else single-pending → return it.
5. Else error.

Key change vs today: **`to`/`replyTo` (explicit intent) win over
`currentTurnContext` (implicit default)**, reversing the precedence that causes
#2. `currentTurnContext` becomes the *default* when the caller specifies
nothing, not an override.

### 4.3 `reply` action threads `replyTo`

The `reply` branch in `index.ts` passes `resolveReplyTarget({ to, replyTo })`
(both already destructured from tool params). No schema change — `replyTo` is
already an accepted `intercom` parameter.

### 4.4 Turn-context binding (edge #3/#4)

Tighten `queueTurnContext`/`beginTurn` so a turn-context is consumed only by the
turn it triggered, not an arbitrary later turn:

- Tag each queued turn-context with the delivery's intent and only let
  `beginTurn` adopt one when the turn was actually intercom-triggered (the
  triggering path already knows this — it sets `triggerTurn: true`). A
  user-initiated turn leaves `currentTurnContext` null.

This is the one part that may warrant a follow-up rather than the first cut; see
§7 phasing.

### 4.5 Lifecycle hygiene (edge #9)

- On `session_left`, prune `pendingAsks` from the departed sender (the answerer
  can no longer usefully reply).
- A reply that arrives with a `replyTo` matching **no** live waiter is rendered
  as "(late reply to a closed ask)" instead of a fresh "📨 From X" message.

### 4.6 What stays separate

`pendingIdleMessages` is delivery-gating (deliver-when-idle), not correlation.
It is **not** merged. Conflating it would couple two real responsibilities.

---

## 5. API / behavior changes (user-visible)

- `intercom({ action: "reply", replyTo: "<id from pending>", message })` now
  targets a specific pending ask. (`pending` already surfaces the ids.)
- `reply` with an explicit `to` is honored even inside a triggered turn.
- Concurrent `ask`/`aside`/`contact_supervisor` no longer fail with "Already
  waiting for a reply".
- Error text for same-sender ambiguity changes to recommend `replyTo`.
- No wire-protocol change. No `intercom` tool schema change.

---

## 6. Backward compatibility

- Existing single-ask, reply-hint, and `to`-based flows are unchanged (steps
  3-4 of §4.2 preserve them).
- The broker is untouched; this is entirely client-side (`index.ts` +
  `reply-tracker.ts`).
- `replyResolvesWaiter` is either removed (folded into the map lookup) or
  reduced to the optional sender assertion; its tests are updated accordingly.

---

## 7. Phasing

1. **Phase 1 — inbound selector + `reply` threading (fixes #1, #2).** Smallest,
   highest user value, self-contained in `reply-tracker.ts` + the `reply`
   branch. Tests: same-sender disambiguation, `to`-overrides-context.
2. **Phase 2 — outbound `Map<questionId, Waiter>` (fixes #5-#8).** Replace the
   single slot; demote sender to a security assertion; update `session_left` /
   `disconnected` / `shutdown` rejection to iterate the map. Tests: concurrent
   asks, per-question resolution, cross-talk rejection.
3. **Phase 3 — lifecycle hygiene (#9) + turn-context binding (#3, #4).** Prune
   answerer `pendingAsks` on `session_left`; tag late replies; gate
   `beginTurn` adoption to intercom-triggered turns.

Each phase is independently shippable and reversible.

---

## 8. Test matrix (new)

- Same-sender: two pending asks from one session; `reply({ replyTo })` targets
  each; `reply({ to })` errors with the message-id hint.
- Precedence: in a triggered turn, `reply({ to: other })` lands on `other`, not
  the trigger; `reply({ message })` still lands on the trigger.
- Concurrent outbound: two `ask`s resolve independently by `replyTo`; a reply
  for one does not resolve the other.
- Security assertion: a reply with a valid `replyTo` but the wrong sender does
  not resolve the waiter.
- Lifecycle: sender leaves → answerer's matching `pendingAsks` pruned; a late
  reply (no live waiter) renders as a closed-ask notice, not a fresh message.
- Regression: all existing `reply-tracker.test.ts` cases still pass (single
  pending, `to` across different senders, turn-context, TTL pruning).

---

## 9. Risks

- **Hot, well-tested path.** 84 tests lean on these flows. Mitigate by phasing
  and adding the §8 matrix before/with each phase.
- **Concurrent outbound waits change agent UX.** A blocking `ask` is synchronous
  by design; allowing N in flight is a capability gain (pi runs tool calls
  concurrently), but the prompt guidance should still steer toward one ask at a
  time unless parallelism is intended.
- **Turn-context gating (§4.4)** is the subtlest change; isolating it in Phase 3
  keeps the high-value fixes (Phase 1-2) low-risk.
