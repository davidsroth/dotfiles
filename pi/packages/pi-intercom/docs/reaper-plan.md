# Intercom broker reaper — design plan

**Status:** Proposal, no code changes yet
**Owner:** TBD
**Created:** 2026-05-25
**Trigger:** 70 zombie sessions accumulated in a single broker process over 46 h of normal use; one live pi process on the host.

---

## 1. Root cause analysis

### 1.1 Lifecycle today (read-only audit)

All file references are relative to `pi/packages/pi-intercom/`.

**Registration** — `broker/broker.ts:179-200`

```ts
case "register": {
  ...
  const id = randomUUID();
  setId(id);
  const info: SessionInfo = { ...clientMessage.session, id };
  this.sessions.set(id, { socket, info });
  ...
  writeMessage(socket, { type: "registered", sessionId: id });
  this.broadcast({ type: "session_joined", session: info }, id);
}
```

A fresh UUID is minted **on every register**. The broker has no notion of
"this is the same pi process that was here 30 s ago, just reconnected" —
each reconnect produces a new registry row. The client (`broker/client.ts:152`)
opens a fresh `net.connect` each time, so old rows are only ever removed
when their *old* socket fires `close`.

**Heartbeat** — none.

The only thing close to a heartbeat is `presence` messages
(`broker/broker.ts:265-292`), which the client sends on:

- model selection (`index.ts:1005-1015`)
- explicit name change (`index.ts:553-560`)
- status transitions wired to `agent_start`/`agent_end`/`tool_execution_*`
  (`index.ts:966-996`)

These are **event-driven** and only update `lastActivity` on the broker
side when the client *chooses* to send them. A pi session that sits in
`[thinking]` for 30 min won't emit anything. A pi session that crashes
won't emit anything. There is no timer-driven liveness signal on either
side of the wire.

**Deregistration paths** — there are exactly two, both server-passive:

1. Explicit `unregister` — `broker/broker.ts:202-208`. Sent by
   `client.disconnect()` (`broker/client.ts:378-410`) which the
   extension calls from the `session_shutdown` hook
   (`index.ts:939-957`).
2. Socket `close` event — `broker/broker.ts:142-149`:

   ```ts
   socket.on("close", () => {
     if (sessionId) {
       this.sessions.delete(sessionId);
       this.broadcast({ type: "session_left", sessionId }, sessionId);
       this.scheduleShutdownCheck();
     }
   });
   ```

There is **no third path**. No periodic sweep, no PID check, no
keepalive, no idle timeout. The broker assumes the kernel will deliver
`close` for every dropped socket, eventually.

### 1.2 Why that assumption is unsafe

- **SIGKILL with pending writes**: when a pi process is `kill -9`'d, the
  kernel reclaims its FDs and the peer side (the broker) eventually sees
  a half-close. On macOS Unix domain sockets this normally surfaces as
  `EOF` → Node emits `close`. But it can be delayed indefinitely when
  the peer was paused (`SIGSTOP`), when the process is wedged in
  uninterruptible I/O, or — empirically the most common cause for the
  symptom we observed — when the parent terminal/iTerm tab process keeps
  the FD alive after the node child is dead. The broker has 19 open FDs
  in `lsof` against a single live pi; some of those are very likely held
  open by ancestor processes that survived the pi.
- **Crash mid-protocol**: if the client errors out of
  `createMessageReader` (`broker/framing.ts`), the broker `destroy`s the
  socket (`broker/broker.ts:121`). That should fire `close`, and does,
  for *that* socket. But the registry entry came from a *register*
  message earlier on a different socket if the client reconnected,
  because UUIDs are minted per-connection (see §1.1).
- **Compound effect over 46 h**: every transient broker disconnect
  triggers `scheduleReconnect` (`index.ts:714-728`). Each reconnect
  mints a new UUID server-side. If even 1 % of old sockets fail to
  emit `close` in time, the registry grows monotonically.

### 1.3 Why we see exactly the observed numbers

- **70 entries, 19 FDs**: ~19 are "half-open" — broker still has the
  socket FD but the peer is gone. The other ~51 lost their socket at
  some point, but the corresponding `close` event apparently never
  fired (or fired before `sessionId` was set; that branch in
  `broker.ts:142` is guarded). The most likely combined explanation is
  *both* of:
  - ancestor-process FD inheritance keeping ~19 FDs lingering, and
  - close events being dropped or never emitted by Node on the other
    ~51 connections — possibly because the broker has been swapped /
    paused under memory pressure, or because the macOS kernel never
    surfaced the peer hangup over a Unix domain socket while the FD
    was still referenced elsewhere.
- **"Session not found" on ask** — `broker/broker.ts:248-253`: the
  registry lookup misses because `findSessions(nameOrId)` searched by
  the *name* the user typed, and several registry rows have the same
  stale `name` field but the live row's lookup hits a different code
  path. (Also: `findSessions` returns `[]` for an unknown ID; the only
  case returning "Session not found" is `targets.length === 0`.)
- **10-minute ask timeout** — `index.ts:443-446`. Implemented entirely
  client-side. The broker happily accepted `send` to a dead UUID
  (`broker/broker.ts:218-247`), routed it to a stale socket whose write
  silently buffered into the kernel, and reported `delivered: true` to
  the asker. The client then waited the full 10 minutes for a reply
  that the dead peer cannot produce. (Note: if `targets.length === 0`,
  the broker would have replied `delivery_failed` immediately. The
  10-minute hang means `targets.length === 1` — i.e. the registry
  entry is still there *and* the socket write didn't synchronously
  throw — see §3.4 on ask-side robustness.)
- **Stale half-open broker.sock connections** — directly the §1.2
  failure mode above; nothing in the broker tries to validate them.

### 1.4 Places the existing code is already partly right

- `socket.on("close")` *does* remove the entry and broadcast
  `session_left` (`broker.ts:142-149`). When it fires, it's correct.
  We just need to give it more reasons to fire.
- `SessionInfo.pid` is **already collected at register time**
  (`broker.ts:90`, `index.ts:543`). A PID-based reaper does not require
  any wire-protocol changes — the data is already in the registry.
- `SessionInfo.lastActivity` exists and is updated on presence
  (`broker.ts:286`). It's not currently used for reaping but it's a
  natural input.
- The shutdown check (`broker.ts:151-161`) is the only existing
  background timer; an idle-broker auto-shutdown after the last session
  leaves. The pattern (a single 5 s `setTimeout`) is a useful precedent
  for keeping reaper machinery minimal.
- `BrokerMessage` includes `session_left` (`types.ts:38`), which
  clients already handle (`client.ts:340-349`). A reaper can reuse this
  event verbatim — no new message types needed on the wire.

---

## 2. Concrete failure modes (observed and inferred)

| # | Symptom                                          | Reproduces from                                                | Severity |
|---|--------------------------------------------------|----------------------------------------------------------------|----------|
| 1 | `intercom list` shows 70 entries, 1 live process | 46 h of normal use, no broker restart                          | High     |
| 2 | "Session not found" on ask to a dead name        | Stale UUID present; name lookup races duplicate-name resolver  | Medium   |
| 3 | 10 min hang on ask to dead UUID                  | Broker accepts `send`, kernel buffers write, no fast-fail      | High     |
| 4 | Stale half-open FDs on broker (`lsof` ~19)       | Ancestor-process FD inheritance + missing close events         | Medium   |
| 5 | Broker can grow unbounded                        | Reconnect mints new UUIDs, old rows only cleared on `close`    | High     |
| 6 | `session_left` not broadcast for zombies         | No reaper means observers never learn about the disappearance  | Medium   |

---

## 3. Design options for a reaper

Tradeoff matrix at the end of this section.

### 3.1 Option A — Application-level heartbeat

**Mechanism.** Client sends `{ type: "ping" }` every N seconds. Broker
records timestamp per-session; a periodic sweep evicts sessions whose
last ping is older than `K * N`.

**Code impact.**

- Add `ping` to `ClientMessage` (`types.ts`) and `pong` (or just no-op)
  to `BrokerMessage`.
- Client: timer in `IntercomClient`, started after `connect`, cleared
  on `disconnect`.
- Broker: stamp `lastSeen` on every message received from client
  (not just ping), sweep on a 30 s interval.

**Pros**

- Works regardless of OS / socket weirdness.
- Detects "alive but wedged" peers (process exists but stopped
  responding) — neither B nor C catches that.

**Cons**

- Adds periodic noise per session (small, but visible in `strace`).
- Requires a wire-protocol change → bump the schema, handle
  forward/backward compat for old clients connecting to new broker
  and vice versa.
- Doesn't distinguish "slow but alive" (a session in a 30 min tool
  call) from "dead". The client has to keep sending pings even when
  busy — needs to run on the event loop independently of the
  agent/tool work, which it already does (Node's event loop will
  service the timer regardless of what the agent is doing — *unless*
  the agent does sync CPU work, which pi tools generally don't).

### 3.2 Option B — Socket-aware reaping (hardening what's there)

**Mechanism.** The broker already removes sessions on `socket.on("close")`.
Add:

- `socket.setKeepAlive(true, …)` on accept — note this is a no-op on
  Unix domain sockets, but harmless and explicit.
- `socket.setTimeout(idleMs)` on accept; on the `timeout` event, write
  a `ping` request and start a short grace timer. If no traffic before
  the grace expires, `socket.destroy()` (which forces a `close`).
- Make sure `error` events on the socket also tear down the registry
  entry, not just log (`broker.ts:154-156` currently only logs).

**Code impact.**

- ~10 lines in `handleConnection` to add the timeout/idle handler.
- The grace-period "ping" requires the wire-protocol change from
  Option A; if we don't want that, the broker can just `destroy` the
  socket on first timeout, which is more aggressive.

**Pros**

- Server-side only (if we skip the in-band ping).
- Builds on the existing close handler — minimal new state.

**Cons**

- Unix domain sockets don't support TCP keepalive, so
  `setKeepAlive` is informational at best. The mechanism reduces to
  `setTimeout + destroy`, which is a coarse "if I haven't heard
  anything in K seconds, drop you" rule. That kills idle-but-alive
  sessions (the `[thinking]` for 30 min case) unless we tune K
  generously — at which point we're a slow reaper.
- Doesn't catch the "broker has the FD, peer is dead, kernel hasn't
  delivered EOF" case unless we also force traffic (back to Option A).

### 3.3 Option C — Process-existence check (PID-based liveness)

**Mechanism.** `SessionInfo.pid` is already stored at register time
(see §1.4). On a periodic sweep (e.g. every 30 s), the broker calls
`process.kill(pid, 0)` for each registered session. If `kill` throws
`ESRCH`, the process is gone — drop the registry entry, emit
`session_left`, and `destroy()` the held socket.

**Code impact.**

- ~25 lines in `broker.ts`: one `setInterval`, one method
  `reapDeadSessions()`, hook it into `start()` and clear in
  `shutdown()`.
- No wire-protocol changes.
- No client changes.

**Pros**

- Catches every case Option B misses, including the "FD held by
  ancestor process" hazard — even if the broker still has the FD
  open, if the *pi process PID* is gone, the entry is reaped.
- Server-side only; client code is untouched.
- Cheap: `kill(pid, 0)` is a single syscall, no IPC.
- Cross-platform within the platforms pi supports: macOS, Linux, and
  Windows (Node's `process.kill(pid, 0)` works on Windows too, with
  the documented semantic that it returns true even for zombie
  processes — see §5.2 for the edge case).

**Cons**

- Doesn't detect "process is alive but the pi runtime has hung" —
  but that's a deeper problem and we can layer Option A on top later
  if it comes up.
- **PID reuse hazard**: if a dead pi (PID 6039) gets reaped slowly
  enough that PID 6039 is re-assigned to an unrelated process before
  the sweep runs, the sweep will see "alive" and *not* reap the dead
  registry entry. Mitigated by also stamping `startedAt` (already in
  `SessionInfo`) and reaping if `pid` is alive but the *process
  start time* doesn't match what we recorded. On macOS we'd need
  `ps -o lstart= -p PID` or read from `kproc`; cross-platform this
  becomes annoying. **Pragmatic stance:** in practice on a developer
  laptop PID reuse within the sweep window (30 s) is vanishingly
  rare. Defer the start-time check; document the residual risk.
- **`kill(pid, 0)` from a non-root broker against a process owned by
  another user** raises `EPERM`, not `ESRCH`. The broker should
  treat `EPERM` as "alive" (because the process exists), not as
  "gone". This matters on shared dev machines but is also
  vanishingly rare for pi.

### 3.4 Ask-side robustness (orthogonal but related)

Independent of the reaper, the broker's `send` handler
(`broker/broker.ts:218-247`) calls `writeMessage(targets[0].socket, …)`
and immediately replies `delivered`. Node's `socket.write` returns
synchronously even when the kernel buffer is full / peer is dead;
errors surface asynchronously via the `error` event, which the
broker only logs.

**Fix:** when `findSessions` resolves to a single target, validate
the target socket's writability *before* claiming delivery:

```ts
if (target.socket.destroyed || !target.socket.writable || target.socket.writableEnded) {
  this.sessions.delete(targetId);                                // belt-and-braces reap
  this.broadcast({ type: "session_left", sessionId: targetId });
  writeMessage(socket, { type: "delivery_failed", messageId, reason: "Session disconnected" });
  break;
}
```

This gives us a **fast-fail within milliseconds** for asks targeting
half-dead sockets — independent of any periodic reaper interval —
and it pre-emptively cleans up the registry entry.

The 10-minute client-side ask timeout (`index.ts:443-446`) should
also be reduced for the "delivery succeeded but no reply" case. A
sensible split:

- If the broker replies `delivery_failed`, ask returns immediately
  (already true).
- If the broker replies `delivered` but no reply arrives, keep the
  10-minute ceiling (slow tool calls are real).
- New: if the recipient's `session_left` event arrives while we're
  waiting for a reply, fail the waiter fast with
  `"Recipient session ended before replying"`. The client already
  listens for `session_left` (`broker/client.ts:340-349`), so this
  is a small additional handler in `index.ts` to cross-check against
  `replyWaiter.from`.

### 3.5 Recommendation — Option D = C + 3.4 + a small slice of B

**Primary mechanism: Option C (PID liveness sweep, 30 s interval).**
Smallest patch, no protocol change, catches the observed failure
mode directly.

**Plus the §3.4 ask-side fast-fail.** It's a 5-line broker change
that converts the 10-minute hang into a sub-second error today, even
if the reaper hasn't caught the dead session yet.

**Plus from Option B**: in the `socket.on("error")` handler
(`broker.ts:154-156`), call the same cleanup path as `close` (drop
the registry entry, broadcast `session_left`). Currently `error`
only logs.

**Defer Option A.** Revisit only if we see "process alive, runtime
wedged" in the wild. Adding a heartbeat now is a wire-protocol
change for a problem we don't have evidence of yet.

### 3.6 Tradeoff matrix

| Aspect                              | A (heartbeat) | B (socket idle) | C (PID check) | **D = C + 3.4 + B.error** |
|-------------------------------------|---------------|-----------------|---------------|---------------------------|
| Catches SIGKILL                     | ✅            | ✅ (delayed)    | ✅            | ✅                        |
| Catches crashed process             | ✅            | ✅              | ✅            | ✅                        |
| Catches wedged-but-alive runtime    | ✅            | ✅              | ❌            | ❌                        |
| Catches stale half-open FD          | ✅            | ✅ (delayed)    | ✅            | ✅                        |
| Fast-fails an ask to dead peer      | ❌            | ❌              | partial       | ✅                        |
| Wire-protocol change?               | yes           | optional        | no            | no                        |
| Client code change?                 | yes           | no              | no            | no (broker-only)          |
| Lines of code added                 | ~80           | ~20             | ~30           | ~45                       |
| Risk of reaping a busy live session | low           | medium          | very low      | very low                  |

---

## 4. Migration / safety

### 4.1 In-flight asks during reaping

When the reaper drops a session that has a pending inbound ask from
another session, the asker is waiting on `replyWaiter` (10-min timer).
Today it just times out. With the §3.4 hook on `session_left`, the
asker fails fast with a clear message. This is strictly better than
status quo; no migration needed.

### 4.2 The "slow but alive" hazard

A pi session in `[thinking]` for 30 min is **normal**. The reaper
must not reap it.

- **Option C is naturally safe here**: `kill(pid, 0)` succeeds as long
  as the process exists, regardless of whether the runtime is busy or
  idle.
- The §3.4 `socket.writable` check is also safe: a busy pi has an
  open, healthy socket — writability is independent of the agent's
  work.
- We do **not** add an "if `lastActivity` is older than X then reap"
  rule. `lastActivity` is fine for sorting `intercom list`; it's a
  bad reaping input.

### 4.3 PID reuse

See §3.3 cons. Residual risk acknowledged, mitigation deferred.
Document explicitly in the broker source comment so a future reader
doesn't have to re-derive it.

### 4.4 Reaper sweep racing concurrent activity

The reaper must not race the `register` handler. Today the broker is
single-threaded JS, so the sweep runs as a single task on the event
loop. As long as `reapDeadSessions()` is synchronous and runs
between event-loop turns, registers from new clients can't
interleave. **Action item:** the sweep stays synchronous — do
`kill(pid, 0)` inline, do not introduce `await` in the sweep.

### 4.5 What happens to held sockets on reap

The reaper should `socket.destroy()` after removing the entry. This
guarantees the FD is released to the kernel and any future write
attempts (e.g. a racy `send` mid-sweep) throw synchronously.

### 4.6 Broker auto-shutdown interaction

`scheduleShutdownCheck` (`broker.ts:151-161`) shuts the broker down
5 s after the last session leaves. The reaper triggers
`session_left`; we need it to *also* trigger `scheduleShutdownCheck`,
so a broker that just reaped its last zombie shuts down cleanly.
Currently shutdown check is only called from `close` and `unregister`.
Add a call in the reaper after each removal.

### 4.7 Rollback

The reaper is a pure addition — one `setInterval`, one method, one
config knob (`REAPER_INTERVAL_MS`, env-overridable). To roll back:
remove the `setInterval` call in `start()`, leave the dead-code
sweep in place. No state migration. The wire protocol is unchanged,
so old clients keep working against new brokers and vice versa.

---

## 5. Operational hygiene

### 5.1 `intercom reap` admin command

For forcing a clear without restarting the broker (useful while
testing this very change, and for users who hit a residual zombie
between sweep intervals):

- Add a new client message `{ type: "admin_reap", requestId }` in
  `types.ts`.
- Broker handler runs `reapDeadSessions()` immediately and replies
  `{ type: "admin_reap_done", requestId, reaped: number }`.
- Surface as a CLI: `pi intercom reap` or `/intercom reap` overlay
  action.

This is the smallest "trust but verify" tool the user needs.

### 5.2 `broker.pid` rotation policy

Today `broker.pid` is written once in `start()` (`broker.ts:124`)
and removed in `shutdown()` (`broker.ts:330`). After 46 h of uptime
this is still the original PID — there is no rotation, and that's
fine; the PID file is a single-broker discovery mechanism, not a
log.

What *would* help:

- On broker startup, if `broker.pid` exists and points at a live
  PID that's also bound to the socket, exit silently (this is
  already covered by `isBrokerRunning` in `spawn.ts:189-202`).
- On broker startup, write a sibling `broker.startedAt` file with
  the timestamp. Use it from a future "uptime" admin command.
- Periodically (every reaper sweep) re-write `broker.pid` with the
  same PID + a "last-heartbeat" timestamp on a second line. A
  watchdog (or future systemd unit, launchd, etc.) can use this to
  detect a wedged broker. Cheap, side-effect-free.

### 5.3 Broker recycling

A 46-h-old broker holding 70 stale registry entries is itself a code
smell. Consider:

- **Self-recycle:** if registry size ever exceeds N (e.g. 32) after
  a reap sweep, log a warning. If it exceeds 2N, force-shutdown
  (the spawn machinery in `broker/spawn.ts` will restart on next
  client connect). Set N high enough that real multi-session users
  aren't bitten.
- **Periodic restart:** out of scope — bring this up only if the
  reaper alone is insufficient.

### 5.4 Diagnostic logging

The broker currently logs only `"Intercom broker started"` and
`"Broker shutting down"` (plus socket-error stack traces). Add at
INFO level:

- `reaped session=<id> name=<name> pid=<pid> reason=esrch|eperm|socket-dead`
- `registry size after sweep: <n>`

Don't add per-tick "swept, 0 dead" noise; only log when something
changed.

---

## 6. Test strategy

All new tests go in `pi/packages/pi-intercom/intercom.integration.test.ts`
(which already spawns real brokers via tsx — see `waitForBrokerReady`)
or a new file `broker/reaper.test.ts`.

### 6.1 Unit-ish (broker-only, no client)

1. **`kill(pid, 0)` reaps an ESRCH session.** Register a client with
   a fake PID that doesn't exist. Run one sweep. Assert the registry
   is empty and a `session_left` was broadcast to other clients.
2. **`kill(pid, 0)` keeps a live session.** Register with
   `process.pid` (the test process). Run one sweep. Assert the
   registry still has the entry.
3. **`EPERM` is treated as alive.** Mock `process.kill` to throw
   `EPERM`. Assert no reap.
4. **Socket-error parity with close.** Trigger `socket.emit("error",
   new Error("boom"))` on a registered connection. Assert the
   registry entry is removed and `session_left` is broadcast.

### 6.2 Integration

5. **SIGKILL on a registered client.** Spawn two pi processes
   pointing at a single broker. SIGKILL one. Wait for the next
   reaper sweep (or call admin_reap). Assert (a) the other session
   receives `session_left`, (b) `intercom list` returns one entry.
6. **Ask to dead UUID fast-fails.** Register A and B. Force B's
   socket into a `destroyed` state (don't `unregister`, simulate
   half-dead). Send an ask from A → B. Assert A receives
   `delivery_failed` within 1 s (not 10 minutes).
7. **`session_left` cancels a pending ask.** A sends an ask to B,
   B is then SIGKILL'd, reaper runs. A's `waitForReply` rejects
   with "Recipient session ended before replying" within 30 s,
   not after 10 min.
8. **Reaping does not affect a busy-but-alive session.** Register A
   and B. Hold B in a tool-call style busy state (no presence
   updates for 60 s, no client message traffic). Run two sweeps.
   Assert B is still registered.
9. **Broker restart with stale registry.** This one is mostly a
   *non-test*: the broker keeps state in memory only, so a broker
   restart starts with an empty registry. Verify this remains true
   (no on-disk registry snuck in).
10. **Multi-tenancy race.** Register A, drop A's socket without
    `unregister`, immediately re-`connect` from the same pi PID
    (new UUID). Run the reaper. Assert the *old* row is gone and
    the *new* row remains. This is the path that, over 46 h, caused
    the observed 70 entries.

### 6.3 Property-style

11. Over a 30 s scripted run with random connect/disconnect/SIGKILL
    activity from 8 simulated clients, assert that registry size
    never exceeds (live clients + 1) at sweep boundaries.

### 6.4 Manual smoke

- Run `dev.sh` style local pi, leave it alone for an hour, restart
  pi, run `intercom list` — should show only the live session(s).
- Trigger the admin command: `pi intercom reap` → returns
  `reaped: N` truthfully.

---

## 7. Phased rollout

Each phase is independently shippable and reversible.

### Phase 1 — Ask-side fast-fail (§3.4) — *smallest, highest user value*

- Edit `broker/broker.ts:218-247` to validate target socket
  writability before claiming delivery.
- Add `session_left` handler in `index.ts` near `replyWaiter` to
  cancel a pending ask if its target leaves.
- Tests: 6, 7.
- Rollback: revert the diff.
- **Why first:** turns the 10-minute hang into a 1-second error
  *today*, even before any reaper lands.

### Phase 2 — Hardening the close path (B.error slice)

- Edit the `socket.on("error")` handler in `broker.ts:154-156` to
  also tear down the registry entry.
- Tests: 4.
- Rollback: revert the diff.

### Phase 3 — PID-based reaper (Option C)

- Add `private reapInterval: NodeJS.Timeout | null = null` to
  `IntercomBroker`.
- Add `reapDeadSessions(): number` method using
  `process.kill(pid, 0)` with the `ESRCH`/`EPERM` discrimination
  from §3.3.
- Wire up in `start()` with `setInterval(..., 30_000).unref()`
  so it doesn't block broker shutdown.
- Clear in `shutdown()` before `process.exit`.
- After each removal, call `scheduleShutdownCheck()` (§4.6).
- Tests: 1, 2, 3, 5, 8, 10, 11.
- Rollback: comment out the `setInterval` call.

### Phase 4 — Admin reap command (§5.1)

- Add `admin_reap` / `admin_reap_done` to `types.ts`.
- Broker handler + CLI surface.
- Tests: extend 5 to use `admin_reap` instead of waiting for the
  sweep.
- Rollback: revert; the periodic reaper still does the work.

### Phase 5 — Diagnostic logging + size warnings (§5.3, §5.4)

- Add the INFO logs.
- Optional: size warning at N=32.
- No behavioral change.

**Defer:** Option A (heartbeat) unless evidence appears.

---

## 8. Open questions

1. **Sweep interval.** 30 s is a guess. 10 s is cheaper than people
   think; 60 s is friendlier to laptops in deep sleep. Recommend
   30 s, env-overridable via `PI_INTERCOM_REAPER_INTERVAL_MS`.
2. **Should the reaper run on broker startup?** A broker spawned by
   `spawnBrokerIfNeeded` starts with an empty registry, so no. But
   if we ever persist the registry across restarts, yes.
3. **Does the existing `presence` `lastActivity` field have a role?**
   It's useful for the UI ("idle 4 min") but explicitly *not* a
   reaper input (see §4.2). Document this in the SessionInfo type
   comment.
4. **Cross-user dev machines.** If two users on the same macOS box
   share `/Users/davidroth/.pi/agent/intercom/broker.sock` (they
   don't, paths are per-home — see `broker/paths.ts`), `kill(pid, 0)`
   would EPERM and we'd keep the entry. Confirmed by reading
   `paths.ts:1-20` — socket path is under `homedir()`, so this
   is a non-issue.
5. **Windows.** Node's `process.kill(pid, 0)` works on Windows but
   returns true for zombies. Pi-intercom is used primarily on
   macOS/Linux; the Windows path goes through the `wscript.exe`
   launcher (`broker/spawn.ts:64-99`). If we ever ship the reaper
   on Windows, validate against a zombie process explicitly.
6. **Telemetry.** Do we want to count "sessions reaped per broker
   lifetime" anywhere observable? Suggest a single counter in the
   broker, exposed via `admin_reap_done`.

---

## 9. Filing path — proposed GitHub issue

Yes, file this as an issue against the repo this package vendors
from (see `VENDORED_FROM.md`). **Do not** post unless explicitly
asked.

### 9.1 Proposed title

> Broker accumulates zombie sessions: no liveness check, ask to dead peer hangs 10 min

### 9.2 Proposed body

```
**Symptom**

On a developer machine running pi-intercom for ~46 h with normal
session churn, `intercom list` reported 70 registered sessions
while only one pi process was actually running. Asks targeting
the zombie entries either returned "Session not found" or hung
for the full 10-minute client-side timeout. `lsof` against the
broker PID showed ~19 stale half-open FDs against
`~/.pi/agent/intercom/broker.sock`.

**Root cause**

The broker (`broker/broker.ts`) relies entirely on
`socket.on("close")` to deregister sessions. There is no
heartbeat, no PID liveness check, no socket-idle reaper.

- `register` mints a fresh UUID on every connect
  (`broker.ts:179-200`), so reconnects produce duplicate registry
  rows whose only cleanup path is the *old* socket's close event.
- `close` doesn't always fire — ancestor processes can inherit
  the FD, and on Unix-domain sockets EOF delivery can be
  delayed indefinitely when the peer is SIGKILL'd while writes
  are buffered.
- `send` does not validate the target socket's writability
  (`broker.ts:218-247`); it writes optimistically and replies
  `delivered: true`. The asker then waits the full 10 minutes
  (`index.ts:443-446`) for a reply that cannot come.

**Proposed fix**

PID-based liveness sweep on a 30 s interval, using the
already-recorded `SessionInfo.pid` and `process.kill(pid, 0)`,
plus a fast-fail check in the `send` handler that validates
`target.socket.writable` before claiming delivery, plus a
client-side `session_left` handler that cancels a pending ask
when the recipient leaves.

No wire-protocol change required. Detailed plan in
`docs/reaper-plan.md`.

**Acceptance**

- After SIGKILL'ing a registered client, `intercom list` shows
  one fewer entry within 30 s (one sweep).
- Ask to a dead UUID returns `delivery_failed` within 1 s.
- Ask whose target SIGKILLs mid-wait resolves within 30 s, not
  10 min.
- A pi session sitting in `[thinking]` for 30 min is *not* reaped.
```

---

## 10. Appendix — key file:line references

| Concern                              | File                          | Lines        |
|--------------------------------------|-------------------------------|--------------|
| Broker registry Map                  | `broker/broker.ts`            | 104          |
| Register handler (UUID mint)         | `broker/broker.ts`            | 179-200      |
| Unregister handler                   | `broker/broker.ts`            | 202-208      |
| Socket close handler                 | `broker/broker.ts`            | 142-149      |
| Socket error handler (logs only)     | `broker/broker.ts`            | 154-156      |
| `send` handler (no writability gate) | `broker/broker.ts`            | 218-263      |
| Presence handler (`lastActivity`)    | `broker/broker.ts`            | 265-292      |
| Shutdown check timer                 | `broker/broker.ts`            | 151-161      |
| Client `connect`                     | `broker/client.ts`            | 152-244      |
| Client `disconnect`                  | `broker/client.ts`            | 378-410      |
| Client send / list timeouts          | `broker/client.ts`            | 446-499      |
| Client session_left handler          | `broker/client.ts`            | 340-349      |
| Extension reconnect logic            | `index.ts`                    | 411-415, 699-728 |
| Extension session_shutdown cleanup   | `index.ts`                    | 939-957      |
| Extension `waitForReply` (10 min)    | `index.ts`                    | 430-470      |
| Broker socket path (per-home)        | `broker/paths.ts`             | 1-20         |
| Broker spawn / pid-file              | `broker/spawn.ts`             | 124-205      |
| Wire types                           | `types.ts`                    | 1-46         |
