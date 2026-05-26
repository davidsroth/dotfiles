# Scope: `pi-intercom-tailnet` — channels across a Tailscale tailnet

> Status: scoping draft. No code yet. Goal of this doc: nail the topology,
> trust model, naming, and protocol surface so MVP work can start with
> clear edges. Decision points are flagged **DECIDE**.

## 1. Problem statement

Today `pi-intercom` is a single-machine coordination layer:

- One broker per host listening on a **Unix domain socket** (UDS — an IPC
  socket file local to the host, not reachable over the network) at
  `~/.pi/agent/intercom/broker.sock`. Windows uses a named pipe with the
  same shape.
- All pi sessions on the host connect, register, and address each other
  by name or session-id.
- Direct 1:1 messaging (`send`, `ask`, `reply`) and presence/list.
- Auto-spawned, auto-shutdown after 5s with no clients.

This is great when both sessions live on one laptop, but it doesn't help
when:

- I'm driving sessions on my Mac and a Linux dev box over Tailscale.
- A teammate (or my future self on another node in the same tailnet) wants
  to bounce context into my running planner without copy-paste.
- A long-lived **topic board** wants to span machines — e.g. an `oncall`
  bulletin board where any participating session can post status updates
  and any other participating session can pull them on demand.

We want to **extend** intercom with two cross-host primitives:

1. **Direct messages across the tailnet** — push, request-gated
   (§4), the same `send` / `ask` / `reply` semantics as today, just
   routed across hosts.
2. **Channels as post-only boards** — *pull-based*. Posting appends
   to a topic log; it does **not** push into any other session. Other
   participants read the board when they choose. This is the key
   semantic departure from a chat-room model; see §7.

Non-goal: building a chat product. Channels are bulletin boards, not
rooms. Keep the surface small.

## 2. Adjacent prior art (in the README)

- `pi-intercom` itself — 1:1, same machine, name-routed.
- `pi-messenger` — referenced as the "shared chat room for multi-agent
  swarms" alternative. We are **not** replacing it; channels here are a
  cross-host extension of the targeted-routing model, not a swarm bus.
- `pi-subagents` — supervisors/children. Unaffected; the new tailnet
  surface should compose with `contact_supervisor` if a supervisor lives
  on another node.

## 3. Architecture options

### Option A — Per-host **tailnet relay** daemon (recommended)

```
 ┌───────────── host A ─────────────┐         ┌───────────── host B ─────────────┐
 │ pi-session ──┐                   │         │ pi-session ──┐                   │
 │ pi-session ──┼──► local broker ◄─┼──relay──┼──► local broker ◄─┬── pi-session │
 │ pi-session ──┘     (UDS)         │  TCP/TS │       (UDS)       └── pi-session │
 │                       ▲          │         │          ▲                       │
 │                       │          │         │          │                       │
 │             tailnet-relay (TS)   │ ◄─────► │ tailnet-relay (TS)               │
 └──────────────────────────────────┘         └──────────────────────────────────┘
```

- Local broker stays **unchanged** for the in-process case.
- A new per-host daemon (`pi-intercom-tailnet-relay`) connects to the
  local broker as a regular client *and* listens on a Tailscale-bound
  TCP port (e.g. `100.x.x.x:4321`).
- The relay registers one "virtual session" per remote member of each
  joined channel, with a synthetic name like `worker@hostB`.
- Local sessions send to those virtual sessions exactly like local
  sessions. The relay forwards the wire bytes over Tailscale to the peer
  relay, which re-injects into its local broker.

**Pros:**

- Local broker, framing, tests unchanged. Cleanest blast radius.
- Naturally inherits Tailscale's transport encryption + ACLs.
- Channels are an additive concept; opt-in by joining.
- No new auth: we trust whoever Tailscale tells us is on the wire.

**Cons:**

- Extra process per host.
- Name collisions cross-host need a disambiguation rule (see §5).
- The relay needs to know the local broker's UDS path (already standard).

### Option B — Single elected tailnet broker

One machine in the tailnet runs THE broker, all others connect over TS.

**Pros:** one source of truth; simplest routing.
**Cons:** single point of failure; conflicts with same-host auto-spawn
behaviour (now we'd have two brokers per host: local and tailnet);
election protocol is non-trivial.

### Option C — Direct P2P mesh per session

Each pi session opens its own listener and connects to peers directly.

**Pros:** no daemon.
**Cons:** sessions are short-lived; firewall semantics get weird;
discovery becomes painful; doesn't survive `pi --resume`.

**DECIDE-1**: Default to **Option A**. The rest of this doc assumes it
unless you push back.

## 4. Trust & opt-in model

The model is **layered opt-in + per-peer request-gated approval**.
Joining a channel makes you *reachable*; it does not auto-grant any
participant the right to actually deliver a message into your session.
First contact from any new peer is a permission prompt, with an
optional time-bound trust grant so you don't get re-prompted on every
message.

### 4.1 Layers (each independently opt-in)

1. **Host opt-in.** The tailnet relay does not run unless
   `~/.pi/agent/intercom/tailnet.json` exists with `enabled: true`.
   Absent file → today's behaviour, nothing leaks off-host.
2. **Channel opt-in.** A host only joins channels listed in that file
   (or added at runtime by an agent via a new `join_channel` tool
   action). Joining is per-host; sessions on that host are then
   *eligible* to see the channel.
3. **Session opt-in.** Per-session config decides whether traffic from
   joined channels surfaces inline, as notifications, or only via
   `list`. Default for `direct messages from off-host peers`: surface as
   a permission prompt, not auto-rendered. Mirrors how `confirmSend`
   already gates send-from-agent today.
4. **Per-peer request gate (new, the interesting part).** See §4.2.

### 4.2 Request-gated approval flow

When a peer (`worker@nimbus`) tries to deliver into your session for
the first time — DM or `#channel` post — the relay holds the message
and surfaces an approval prompt in your session:

```
  worker@nimbus wants to send you a message on #oncall
  Preview: "Found a regression in the deploy pipeline, can you look?"
  Approve:
    [o] once     — just this message
    [s] session  — until this pi session ends
    [h] 1 hour   — auto-renew on each new message in the hour
    [d] always   — persistent allow
    [n] no       — drop, sender sees delivery_failed
```

Key properties:

- **Identity = Tailscale identity.** Peer key = `(tailscale-node-id,
  user-tag)` from `tailscale whois`, not just the human-readable
  `worker@nimbus` (which can be re-used). Approvals bind to the strong
  identity; the display name is for humans.
- **Scopes** the approval can carry: `dm-only`, `channel: #oncall`,
  `all-channels`. Default scope of an `o`/`s`/`h` grant is whatever
  channel/DM triggered the prompt; `d` widens to peer-global with an
  explicit confirm.
- **Time-bound grants** (`h` = 1h is the canonical example) live in
  a small grants table; the relay TTL-evicts. A new message inside the
  window silently passes through; a new message at second 3601 prompts
  again. **DECIDE-A**: should `h` *sliding-window-extend* on each
  message (always 1h from last contact), or be a *fixed* 1h from grant?
  Lean: fixed window — predictable and the user explicitly re-affirms.
- **Persistent grants** (`d` = always) get written to
  `~/.pi/agent/intercom/grants.json` keyed by tailnet identity. List /
  revoke via `intercom({action: "list_grants"})` and
  `intercom({action: "revoke_grant", peer: "..."})`.
- **Approval is per-recipient session, not per-host.** Two pi sessions
  on the same host approve independently. The relay never silently
  fans out a message to a session that hasn't granted the sender.
- **Pending state in the sender.** While a request is pending, the
  sender sees `delivery_pending` (a new `BrokerMessage` kind) and `ask`
  blocks; an `n` (deny) resolves it with `delivery_denied`.
- **Deny is indistinguishable from "no session by that name" /
  "recipient offline".** Sender gets a generic failure with no reason
  string. Why this matters: without that, a hostile or noisy peer can
  probe the tailnet to discover *which* of my sessions exist and are
  awake — send DMs to a list of candidate names, watch which ones
  return "denied" (session exists, said no) vs `session_not_found`
  (does not exist) vs `pending` (exists, user is being prompted right
  now). That's a presence oracle and a fingerprinting channel even
  before any content gets through. Collapsing all three to one opaque
  `delivery_failed` removes the oracle. Same reason SSH doesn't tell
  you whether the username was wrong or the password was wrong.

### 4.3 Authentication primitives the gate sits on top of

- Bind the relay listener to the Tailscale interface only
  (`tailscale ip -4 | head -n1`), or `0.0.0.0` + a `tailscale whois`
  check on accept. Refuse the connection if `whois` can't resolve the
  caller to a tailnet identity.
- Optional coarse ACL in `tailnet.json`: `allowedNodes` /
  `allowedTags` arrays, matched against `tailscale whois --json`.
  Failing this ACL = connection rejected before any approval prompt
  ever fires (the gate is for *which* approved peers can talk; the ACL
  is for *who is even allowed to ring the doorbell*).
- Optional per-channel pre-shared key. **PSK = pre-shared key**, a
  shared secret distributed out-of-band that both sides know in
  advance. The relay would **HMAC** each frame with the PSK
  (HMAC = Hash-based Message Authentication Code — a keyed integrity
  tag; receiver re-computes it with the same key and rejects frames
  whose tag doesn't match, so a stranger without the key can't forge
  or tamper). Tailscale already encrypts the wire, so PSK/HMAC is
  belt-and-suspenders defence against e.g. an accidentally-public
  listener or a misconfigured ACL. **DECIDE-2**: ship MVP without PSK
  and rely on Tailscale + ACL + the request gate, or include from
  day one?

Explicitly not in scope: cross-tailnet federation, internet-exposed
brokers, multi-tenant ACL grammars.

## 5. Naming & addressing

Today: `name` or `sessionId`. Both are flat.

Proposal:

DMs (the push-style send/ask/reply):

- `name@host` where `host` is the Tailscale MagicDNS short name (e.g.
  `worker@nimbus`).
- Bare `name` keeps current semantics: local sessions first, then a
  single unique match across the discovered tailnet. Multiple matches
  → ambiguous error, same as today.
- `sessionId` (UUID) remains globally unique.

Channels are **never** a `to:` value, because channels are not push
targets. They have their own verbs (`post`, `read`, `tail`) — see §7.
There is intentionally no `to: "#channel"` syntax.

**DECIDE-3**: Should bare `name` search local-only by default, with
opt-in `crossHost: true` per call to widen? Safer default, less magic,
but more typing.

## 6. Protocol changes

### Local UDS wire (existing)

No incompatible changes. Add **additive** message kinds the broker can
ignore if old. DMs reuse the existing `send` / `message` envelopes — the
relay just appears as another session. Channels get their own verbs
because they are not session-routed:

```ts
// types.ts additions
type ClientMessage =
  | ...existing...
  // channel membership (host-level intent, surfaced via the session
  // that asked for it)
  | { type: "join_channel"; channel: string }
  | { type: "leave_channel"; channel: string }
  | { type: "list_channels"; requestId: string }
  // post-only channel ops
  | { type: "post"; channel: string; message: Message }
  | { type: "read_channel"; requestId: string; channel: string;
      since?: number /* ms */; limit?: number }
  | { type: "tail_channel"; channel: string; subscribe: boolean };

type BrokerMessage =
  | ...existing...
  | { type: "channels"; requestId: string; channels: ChannelInfo[] }
  | { type: "channel_joined"; channel: string }
  | { type: "channel_left"; channel: string }
  | { type: "channel_posts"; requestId: string; channel: string;
      posts: ChannelPost[] }
  | { type: "channel_post_appended"; channel: string; post: ChannelPost }
  | { type: "remote_session_joined"; session: SessionInfo; via: "tailnet" }
  | { type: "remote_session_left"; sessionId: string };

interface ChannelPost {
  id: string;
  channel: string;
  authorHost: string;       // MagicDNS short name
  authorSession?: string;   // optional: the session that posted
  authorName?: string;      // display name of that session, if any
  timestamp: number;
  content: { text: string; attachments?: Attachment[] };
}
```

`SessionInfo` gains an optional `host?: string` (Tailscale node short
name) and `origin?: "local" | "tailnet"`.

Important property: `channel_post_appended` is **only** sent to a
session that has explicitly called `tail_channel({channel, subscribe:
true})` in the current session. The default for a session that has
merely *joined* a channel (via host config or `join_channel`) is
pull-only — it sees nothing inline. Tailing is an explicit per-session
act, like `tail -f`: you opt your session in to live updates of a
specific board. This keeps the post-only invariant: posts never enter a
session's transcript without that session having asked.

### Tailnet wire (new)

Reuse the existing length-prefixed JSON framing from `broker/framing.ts`
so the relay is a thin bridge. Add a small handshake plus the
channel-replication kinds:

```ts
type TailnetHello = {
  type: "tailnet_hello";
  protocolVersion: 1;
  host: string;          // MagicDNS short name of sender
  channels: string[];    // channels this relay subscribes to
  features?: string[];
};

// channel sync — gossip new posts between peer relays
type TailnetChannelPost = {
  type: "tailnet_channel_post";
  channel: string;
  post: ChannelPost;
};

// pull on join — fetch a snapshot from a peer that's been up longer
type TailnetChannelSnapshotReq = {
  type: "tailnet_channel_snapshot_req";
  requestId: string;
  channel: string;
  since?: number;
};
type TailnetChannelSnapshotResp = {
  type: "tailnet_channel_snapshot_resp";
  requestId: string;
  channel: string;
  posts: ChannelPost[];
};
```

DM traffic uses the existing `message` envelope wrapped in a
`tailnet_message` discriminator so the relay can dispatch.

### Storage for channel posts

Each relay keeps a per-channel **append-only ring buffer** on disk at
`~/.pi/agent/intercom/channels/<channel>.log` (newline-delimited JSON;
trivial to inspect with `tail`). Default cap: last 1000 posts or 30
days, whichever first. **DECIDE-D**: cap policy and whether it's per
channel-config tunable.

No central source of truth. Each subscribed host has an eventually-
consistent view; `read_channel` merges local log + posts gossiped from
peers. If the originating host disappears mid-flight, recent posts may
be missing on a freshly-joining peer until either (a) the origin
returns, or (b) another peer that had them gossips them. This is fine
for a bulletin board; it's not fine for chat, and that's a feature.

## 7. Tool surface (the `intercom()` tool)

Additions, all backward-compatible. Two groups: **DM** (push, 1:1,
request-gated) and **channel** (post-only board, pull / opt-in tail).

```ts
// ---- DMs (push, same semantics as today, now cross-host) ----
intercom({ action: "list" })
// also shows remote sessions with `[remote: hostB]` tag

intercom({ action: "send", to: "worker@nimbus", message: "..." })
intercom({ action: "ask",  to: "worker@nimbus", message: "..." })
intercom({ action: "reply", message: "..." })  // unchanged

// `to: "#channel"` is intentionally NOT supported. ask-against-channel
// is not a thing; channels do not push.

// ---- Channels (post-only board) ----
intercom({ action: "list_channels" })
intercom({ action: "join_channel",  channel: "oncall" })
intercom({ action: "leave_channel", channel: "oncall" })

// post: append to the board. Returns when the local relay has
// accepted and queued the gossip. Does NOT confirm peer delivery
// (peers pull / gossip async).
intercom({ action: "post", channel: "oncall",
          message: "deploy pipeline is red on main" })

// read: pull recent posts. Pure session-initiated; no surprise inline.
intercom({ action: "read_channel", channel: "oncall",
          since: 1716500000000, limit: 50 })
// → [{authorHost: "nimbus", authorName: "worker", text: "…", …}, …]

// tail: opt this session in to live appends. Streams as inline
// system messages until the session ends or `subscribe: false`.
intercom({ action: "tail_channel", channel: "oncall", subscribe: true })
intercom({ action: "tail_channel", channel: "oncall", subscribe: false })

// ---- Grants (§4.2 admin) ----
intercom({ action: "list_grants" })
intercom({ action: "revoke_grant", peer: "worker@nimbus" })
```

The verbs are deliberately asymmetric: DMs are `send`/`ask`/`reply`,
channels are `post`/`read`/`tail`. That asymmetry is the surface-level
reminder of the semantic difference. There is no way to accidentally
turn a DM into a broadcast or vice versa.

## 8. UX considerations

- Inline rendering of incoming remote DMs includes the host hint:
  `**From worker@nimbus** (~/projects/api)`. Falls out of §5 naming.
- The `/intercom` overlay (Alt+M) groups sessions by host, and gets a
  separate `#channels` pane: each joined channel, last-post timestamp,
  unread-since-last-read count. Selecting a channel opens a read view,
  not a compose view; compose (`post`) is a deliberate second step.
- `confirmSend` defaults to **true** for any DM whose recipient is
  off-host. `post` to a channel doesn't need `confirmSend` because
  posting doesn't push into anyone's session — lower blast radius.
- Tailing (`tail_channel subscribe: true`) is **session-scoped and
  non-persistent**: it ends when the session ends. Resumed sessions
  start untailed; the agent has to re-tail explicitly. Stops a stale
  resumed session from getting a firehose of posts it didn't expect.
- Presence: a session's `presence` updates do **not** fan out to other
  hosts in MVP. Cross-host presence is opt-in later via channel
  membership ("who else has joined `#oncall`?"), and even then is a
  pull (`list_channel_members`), not a push. This deletes DECIDE-5
  (throttle policy) from the MVP.

## 9. Discovery

For Option A, peer relays need to find each other.

- **MVP**: shell out to `tailscale status --json` to enumerate peers,
  attempt TCP connect to each on the well-known port, send `hello`,
  drop those that don't speak the protocol. Re-poll every N seconds and
  on `tailscale status` change events (watch the file? signal? just
  poll).
- Avoid mDNS — Tailscale already provides identity & connectivity.
- No central registry, no DNS hacks beyond MagicDNS.

Failure modes:

- Peer offline → drop, retry with backoff.
- Peer running an incompatible `protocolVersion` → log once, ignore.
- Tailscale not installed / not running → relay no-ops, intercom keeps
  working locally.

## 10. Persistence & history

- Channel join state (host-level) lives in
  `~/.pi/agent/intercom/tailnet.json` (config + runtime additions
  written back on join/leave).
- Remote **DMs** flow through Pi's session-history mechanism the same
  way local intercom messages do today, so `pi --resume` shows them.
- Channel **posts** are persisted per-host in
  `~/.pi/agent/intercom/channels/<channel>.log` (§6). A session that
  reads or tails a channel will get those posts surfaced into its
  transcript only at the moment it reads/tails; the log itself is not
  a session artifact.
- Tail subscriptions are intentionally not persisted across
  `pi --resume` (see §8). The host-level channel join *is* persisted.

## 11. Failure / partition behaviour

- Same-host messaging is unaffected by tailnet relay state.
- A tailnet **DM** that can't be delivered (peer offline, peer denied
  the request) returns the opaque `delivery_failed` to the sender, the
  same surface as a local unknown session today (see §4.2 on why the
  reason is opaque).
- `ask` blocks until reply, deny, or peer disconnect; on disconnect it
  resolves with `delivery_failed`.
- A **post** to a channel succeeds locally as soon as the local relay
  has accepted the append. Peer replication is async best-effort. A
  network partition means some hosts will see the post late; no host
  will lose it permanently as long as one subscriber that received it
  stays alive.

## 12. MVP cut

In order, smallest shippable slice first:

1. New package `pi-intercom-tailnet` that depends on `@davidroth/pi-intercom`.
2. Tailnet relay daemon. Auto-start on pi launch if
   `tailnet.json.enabled` is true; auto-shutdown when no channels are
   joined and no DM peers are connected for 60s.
3. **Cross-host DMs** with `to: "name@host"` addressing, plus inline
   rendering with `@host` decoration in receivers.
4. **Request-gated approval** (§4.2): once/session/1h/always grants,
   `grants.json`, `list_grants` / `revoke_grant`. This is the
   user-visible safety story for DMs; ship it with step 3, not after.
5. **Channels as post-only boards** (§7): static channels from config,
   `post` / `read_channel`, per-host log at
   `~/.pi/agent/intercom/channels/<name>.log`, peer gossip + snapshot
   pull on join.
6. Dynamic `join_channel` / `leave_channel` and `tail_channel`.
7. `/intercom` overlay updates: host-grouped session list,
   `#channels` pane with read view.
8. ACLs (`allowedNodes` / `allowedTags`) checked via `tailscale whois`.

Out of MVP, into a roadmap section of the README:

- PSK / per-channel keying.
- Cross-host presence (pulled via `list_channel_members`).
- An explicit *push-subscribe* channel mode for channels where every
  member has consented up front (with its own approval-suppression
  mechanism); the `autoAccept` idea returns there if we want it.
- `pi-messenger`-style swarm semantics on top of channels (probably as a
  separate package).

## 13. Open questions / decision points

| # | Decision | My lean |
|---|----------|---------|
| 1 | Option A vs B vs C topology | **A: per-host relay** |
| 2 | Ship PSK on day 1, or rely on Tailscale + ACLs for MVP | MVP without PSK |
| 3 | Bare `name` searches cross-host by default, or `crossHost: true` opt-in | Opt-in per call (less magic) |
| 4 | Semantics of `ask` against `#channel` | Reject in MVP; first-reply-wins later |
| 5 | Presence fan-out across tailnet — throttle policy | Coalesce to 1/5s per session |
| 6 | Package layout: separate `pi-intercom-tailnet` vs. flag inside `@davidroth/pi-intercom` | **Separate package** (keeps core install slim, makes tailnet feature truly opt-in) |
| 7 | Sibling-package vs. upstream PR | Sibling first; upstream once shape is stable |
| A | Time-bound grant: sliding vs. fixed window | **Fixed** (predictable; user re-affirms) |
| B | Default grant scope: `dm-only` vs. inherit-from-triggering-channel | Inherit; widen only on `d` (always) |
| C | Drop `autoAccept`/allow-by-default channels for MVP? | **Yes, drop.** With §7's post-only channel semantics there is nothing to auto-accept — posts never push into a session, so the prompt that `autoAccept` would have suppressed never fires. Bring it back only if we later add an explicit *push-subscribe* mode and want a way to skip its prompt. |

## 14. Risks

- **Accidentally exposing** the relay outside Tailscale via a config
  typo. Mitigation: bind to TS interface only, refuse to start if
  `tailscale status` can't confirm we're on a tailnet.
- **Name confusion** when two hosts both run `worker`. Mitigation: §5
  addressing + decoration; explicit ambiguous-name error.
- **History pollution**: a noisy `#oncall` channel could flood a
  session's transcript. Mitigation: rate-limit + per-channel inline-vs-
  notification rendering (probably phase 2).
- **Scope creep into pi-messenger territory.** Keep the surface area
  tight; if someone wants chat-room semantics, they can build on top.

---

Next concrete step once decisions land: spike Option A by writing a
`tailnet-relay.ts` that opens a TS-bound listener, connects to the
local broker as `relay:hostB`, and forwards one hardcoded channel.
About 200 lines + the discovery loop. That's the smallest thing that
proves the topology.
