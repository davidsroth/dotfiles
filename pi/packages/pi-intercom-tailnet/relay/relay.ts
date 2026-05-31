// pi-intercom-tailnet relay daemon.
//
// Phase 0 scope (matches scope doc §12 step 2+3):
//   - Listens on a TCP port bound to the Tailscale IPv4 interface.
//   - Accepts inbound connections from peers on the static allowlist.
//   - Periodically polls peers' local broker session lists, registers
//     a virtual local session per remote session as "<name>@<host>".
//   - Routes outbound DMs (local session → virtual session) over the
//     peer link to the right remote relay, which delivers via its
//     local broker.
//
// NOT in Phase 0:
//   - Channels (post/read/tail).
//   - Interactive request-gated approval (just static `allowedHosts`).
//   - ACLs by node tag.
//
// Lifecycle: the relay is its own process, auto-spawned by the pi
// extension when `enabled: true` in tailnet.json. Exits cleanly on
// SIGTERM/SIGINT.

import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import net from "net";
import { writeMessage } from "../framing.js";
import { loadTailnetConfig, isPeerAllowed, type TailnetConfig } from "../config.js";
import { getTailnetStatus, type TailnetStatus } from "../tailscale.js";
import { createBrokerBridge, type BrokerBridge, type VirtualSessionHandle } from "./broker-bridge.js";
import { dialPeer, acceptPeer, type PeerLink } from "./peer-link.js";
import type { IntercomMessage, SessionInfo, TailnetDM } from "../types.js";

const INTERCOM_DIR = join(homedir(), ".pi/agent/intercom");
const RELAY_PID_PATH = join(INTERCOM_DIR, "tailnet-relay.pid");
const BROKER_SOCKET = join(INTERCOM_DIR, "broker.sock");

interface PeerState {
  host: string;
  ipv4: string | null;
  online: boolean;
  outbound: PeerLink | null;
  inbound: PeerLink | null;
  /** Virtual local sessions we host on behalf of this peer's sessions. */
  virtualByRemoteId: Map<string, { handle: VirtualSessionHandle; remoteName: string }>;
}

class TailnetRelay {
  private readonly config: TailnetConfig;
  private selfHost: string | null = null;
  private bridge: BrokerBridge | null = null;
  private server: net.Server | null = null;
  private peers = new Map<string, PeerState>();
  private discoveryTimer: NodeJS.Timeout | null = null;
  private localSessions = new Map<string, SessionInfo>();
  private shuttingDown = false;
  /** Features advertised in hello; used for forward-compat. */
  private readonly features = ["session_discovery"];

  constructor(config: TailnetConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.error("[tailnet-relay] disabled via config; exiting");
      process.exit(0);
    }

    mkdirSync(INTERCOM_DIR, { recursive: true });

    // 1. Discover our own host name via the tailscale CLI (unless overridden).
    if (this.config.hostOverride) {
      this.selfHost = this.config.hostOverride.toLowerCase();
    } else {
      const status = await getTailnetStatus(this.config.tailscaleCli);
      if (!status) {
        console.error("[tailnet-relay] tailscale status unavailable; refusing to start");
        process.exit(1);
      }
      this.selfHost = status.self.host;
      this.applyTailscaleStatus(status);
    }

    // 2. Connect to the local broker (control socket).
    this.bridge = createBrokerBridge({
      socketPath: BROKER_SOCKET,
      controlName: "__tailnet_relay__",
      pid: process.pid,
    });
    this.bridge.on("localSessionJoined", (info) => {
      this.localSessions.set(info.id, info);
      this.broadcastToPeers({ type: "tailnet_session_joined", session: info });
    });
    this.bridge.on("localSessionLeft", (id) => {
      this.localSessions.delete(id);
      this.broadcastToPeers({ type: "tailnet_session_left", sessionId: id });
    });
    this.bridge.on("localSessions", (list) => {
      this.localSessions.clear();
      for (const s of list) this.localSessions.set(s.id, s);
    });
    this.bridge.on("controlClosed", () => {
      if (!this.shuttingDown) {
        console.error("[tailnet-relay] broker control socket closed; shutting down");
        this.shutdown();
      }
    });
    await this.bridge.start();
    // Best-effort initial list so we can populate session caches.
    try {
      const initial = await this.bridge.refreshLocalSessions();
      for (const s of initial) this.localSessions.set(s.id, s);
    } catch {
      // Non-fatal; the joined/left stream will catch up.
    }
    // Exclude our own control socket session from what we advertise.
    // Filter out control session from future broadcasts (it may be in the initial list).
    for (const [id, s] of this.localSessions) {
      if (s.name === "__tailnet_relay__" || s.status === "relay:control") {
        this.localSessions.delete(id);
      }
    }

    // 3. Listen on the Tailscale IPv4 (if we have one). Falling back to
    //    0.0.0.0 + per-connection whois is a roadmap item; for now we
    //    refuse to start without a Tailscale-bound address.
    const ipv4 = this.getSelfIPv4();
    if (!ipv4) {
      console.error("[tailnet-relay] no Tailscale IPv4 detected; refusing to start");
      process.exit(1);
    }
    this.server = net.createServer((socket) => this.handleInbound(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.port, ipv4, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    writeFileSync(RELAY_PID_PATH, String(process.pid));
    console.error(`[tailnet-relay] listening on ${ipv4}:${this.config.port} as ${this.selfHost}`);

    // 4. Discovery loop.
    if (this.config.discovery) {
      this.discoveryTimer = setInterval(() => {
        void this.tick();
      }, this.config.discoveryIntervalMs).unref();
      void this.tick();
    }

    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private getSelfIPv4(): string | null {
    // Phase 0: only inferred from tailscale status, never accept 0.0.0.0.
    // (We stash this on the peer entry for "self" below, but at this point
    // we may not have run discovery yet, so re-query if needed.)
    for (const p of this.peers.values()) {
      if (p.host === this.selfHost && p.ipv4) return p.ipv4;
    }
    return null;
  }

  private async tick(): Promise<void> {
    if (this.shuttingDown) return;
    const status = await getTailnetStatus(this.config.tailscaleCli);
    if (!status) return;
    this.applyTailscaleStatus(status);

    // For each allowed peer that's online, ensure an outbound link.
    for (const peerHost of this.config.allowedHosts) {
      const norm = peerHost.toLowerCase();
      const peer = this.peers.get(norm);
      if (!peer || peer.host === this.selfHost) continue;
      if (!peer.online || !peer.ipv4) continue;
      if (peer.outbound || peer.inbound) continue;
      // No active link → dial.
      this.dialPeerSafely(peer).catch((err) => {
        console.error(`[tailnet-relay] dial ${peer.host}: ${err.message}`);
      });
    }
  }

  private applyTailscaleStatus(status: TailnetStatus): void {
    // Self.
    const self = this.peers.get(status.self.host) ?? this.makePeerState(status.self.host);
    self.ipv4 = status.self.ipv4;
    self.online = status.self.online;
    this.peers.set(status.self.host, self);
    // Peers.
    for (const p of status.peers) {
      const norm = p.host.toLowerCase();
      const existing = this.peers.get(norm) ?? this.makePeerState(norm);
      existing.ipv4 = p.ipv4;
      existing.online = p.online;
      this.peers.set(norm, existing);
    }
  }

  private makePeerState(host: string): PeerState {
    return {
      host,
      ipv4: null,
      online: false,
      outbound: null,
      inbound: null,
      virtualByRemoteId: new Map(),
    };
  }

  private async dialPeerSafely(peer: PeerState): Promise<void> {
    if (!peer.ipv4 || !this.selfHost) return;
    const link = await dialPeer({
      selfHost: this.selfHost,
      peerHost: peer.host,
      peerIp: peer.ipv4,
      peerPort: this.config.port,
    });
    peer.outbound = link;
    this.wirePeerLink(peer, link, "outbound");
    // Once link is ready, send our current local session list.
    link.once("ready", () => {
      link.send({ type: "tailnet_sessions", sessions: this.getLocalSessionsForBroadcast() });
    });
  }

  private handleInbound(socket: net.Socket): void {
    if (!this.selfHost) {
      socket.destroy();
      return;
    }
    // Tailscale-only listener means the remote address is already a TS
    // address; the allowlist gate is by host name from the hello.
    const link = acceptPeer({
      selfHost: this.selfHost,
      socket,
      acceptHello: (hello) => {
        if (!isPeerAllowed(this.config, hello.host)) {
          console.error(`[tailnet-relay] reject hello from ${hello.host}: not on allowedHosts`);
          return false;
        }
        return true;
      },
    });
    link.once("ready", (remoteHost) => {
      const peer = this.peers.get(remoteHost.toLowerCase()) ?? this.makePeerState(remoteHost.toLowerCase());
      if (peer.inbound) {
        // Replace stale link.
        peer.inbound.close();
      }
      peer.inbound = link;
      this.peers.set(peer.host, peer);
      this.wirePeerLink(peer, link, "inbound");
      // Send our current local session list to the newly connected peer.
      link.send({ type: "tailnet_sessions", sessions: this.getLocalSessionsForBroadcast() });
    });
  }

  private wirePeerLink(peer: PeerState, link: PeerLink, direction: "inbound" | "outbound"): void {
    link.on("dm", (frame) => this.routeInboundDM(peer, frame));
    link.on("sessionList", (sessions) => this.handlePeerSessionList(peer, sessions));
    link.on("sessionJoined", (session) => this.handlePeerSessionJoined(peer, session));
    link.on("sessionLeft", (sessionId) => this.handlePeerSessionLeft(peer, sessionId));
    link.on("closed", () => {
      if (direction === "outbound" && peer.outbound === link) peer.outbound = null;
      if (direction === "inbound" && peer.inbound === link) peer.inbound = null;
      // Tear down virtual sessions we held on behalf of this peer.
      for (const v of peer.virtualByRemoteId.values()) v.handle.close();
      peer.virtualByRemoteId.clear();
    });
  }

  private broadcastToPeers(frame: { type: string } & Record<string, unknown>): void {
    for (const peer of this.peers.values()) {
      if (peer.host === this.selfHost) continue;
      const link = peer.outbound ?? peer.inbound;
      if (link) link.send(frame as import("../types.js").TailnetFrame);
    }
  }

  private getLocalSessionsForBroadcast(): SessionInfo[] {
    return Array.from(this.localSessions.values()).filter(
      (s) => s.name !== "__tailnet_relay__" && s.status !== "relay:control"
    );
  }

  private handlePeerSessionList(peer: PeerState, sessions: SessionInfo[]): void {
    // Reconcile: create virtual sessions for any we don't have, close any we have that aren't in the list.
    const incomingIds = new Set(sessions.map((s) => s.id));
    // Close stale.
    for (const [remoteId, v] of peer.virtualByRemoteId) {
      if (!incomingIds.has(remoteId)) {
        v.handle.close();
        peer.virtualByRemoteId.delete(remoteId);
      }
    }
    // Create new / refresh existing.
    for (const session of sessions) {
      const displayName = `${session.name ?? session.id}@${peer.host}`;
      const existing = peer.virtualByRemoteId.get(session.id);
      if (existing) {
        // Name may have changed; if so, close and recreate.
        if (existing.remoteName !== displayName) {
          existing.handle.close();
          peer.virtualByRemoteId.delete(session.id);
          this.ensureVirtualForRemote(peer, session.id, displayName);
        }
      } else {
        this.ensureVirtualForRemote(peer, session.id, displayName);
      }
    }
  }

  private handlePeerSessionJoined(peer: PeerState, session: SessionInfo): void {
    const displayName = `${session.name ?? session.id}@${peer.host}`;
    const existing = peer.virtualByRemoteId.get(session.id);
    if (existing) {
      if (existing.remoteName !== displayName) {
        existing.handle.close();
        peer.virtualByRemoteId.delete(session.id);
        this.ensureVirtualForRemote(peer, session.id, displayName);
      }
    } else {
      this.ensureVirtualForRemote(peer, session.id, displayName);
    }
  }

  private handlePeerSessionLeft(peer: PeerState, sessionId: string): void {
    const existing = peer.virtualByRemoteId.get(sessionId);
    if (existing) {
      existing.handle.close();
      peer.virtualByRemoteId.delete(sessionId);
    }
  }

  /** A remote relay DM'd us → deliver to a local session via the broker. */
  private routeInboundDM(peer: PeerState, frame: TailnetDM): void {
    if (!this.bridge) return;
    // Hosts must match what the link's hello claimed.
    if (frame.fromHost.toLowerCase() !== peer.host) {
      this.ackTo(peer, frame.message.id, false, "host mismatch");
      return;
    }
    // Resolve target locally. We need a virtual session to "send" from
    // so the recipient sees the inbound as coming from <name>@<host>.
    const senderDisplayName = `${frame.fromName.replace(/@.*/, "")}@${peer.host}`;
    const virtual = this.ensureVirtualForRemote(peer, frame.fromSessionId, senderDisplayName);

    let target: string;
    if (frame.toResolver.kind === "sessionId") {
      target = frame.toResolver.id;
    } else {
      target = frame.toResolver.name;
    }
    virtual.send(target, frame.message);
    this.ackTo(peer, frame.message.id, true);
  }

  private ensureVirtualForRemote(peer: PeerState, remoteSessionId: string, displayName: string): VirtualSessionHandle {
    const existing = peer.virtualByRemoteId.get(remoteSessionId);
    if (existing && existing.remoteName === displayName) return existing.handle;
    if (existing) existing.handle.close();

    const handle = this.bridge!.openVirtualSession({
      displayName,
      cwd: `tailnet:${peer.host}`,
      model: `tailnet:${peer.host}`,
      onMessage: (from, message) => this.routeOutboundFromLocal(peer, remoteSessionId, from, message),
    });
    peer.virtualByRemoteId.set(remoteSessionId, { handle, remoteName: displayName });
    return handle;
  }

  /** Build a toResolver that works both by bare name and by session id. */
  private resolveTarget(targetNameOrId: string, peer: PeerState): { kind: "name"; name: string } | { kind: "sessionId"; id: string } | null {
    // If the target is a bare name (no @host suffix), resolve against our virtual sessions for this peer.
    const atIndex = targetNameOrId.indexOf("@");
    if (atIndex !== -1) {
      const hostPart = targetNameOrId.slice(atIndex + 1).toLowerCase();
      if (hostPart !== peer.host.toLowerCase()) return null;
      const namePart = targetNameOrId.slice(0, atIndex);
      // Try to find a virtual session with this display name prefix.
      for (const [remoteId, v] of peer.virtualByRemoteId) {
        if (v.remoteName === targetNameOrId || v.remoteName.startsWith(namePart + "@")) {
          return { kind: "sessionId", id: remoteId };
        }
      }
      return { kind: "name", name: namePart };
    }
    // No @host suffix — try matching against virtual session display names.
    for (const [remoteId, v] of peer.virtualByRemoteId) {
      const baseName = v.remoteName.replace(/@.*/, "");
      if (baseName === targetNameOrId) {
        return { kind: "sessionId", id: remoteId };
      }
    }
    return { kind: "name", name: targetNameOrId };
  }

  /** A local session → virtual session "<name>@<host>" → route to peer. */
  private routeOutboundFromLocal(
    peer: PeerState,
    remoteSessionId: string,
    from: SessionInfo,
    message: IntercomMessage,
  ): void {
    if (!this.selfHost) return;
    const link = peer.outbound ?? peer.inbound;
    if (!link) {
      console.error(`[tailnet-relay] drop DM to ${peer.host}: no live link`);
      return;
    }
    // Try to resolve the remote target by session id; if the remote session
    // has since changed name, fall back to sending by name.
    const targetVirtual = peer.virtualByRemoteId.get(remoteSessionId);
    const toResolver = targetVirtual
      ? ({ kind: "sessionId" as const, id: remoteSessionId })
      : ({ kind: "name" as const, name: remoteSessionId });
    const dm: TailnetDM = {
      type: "tailnet_dm",
      fromName: from.name ?? from.id,
      fromHost: this.selfHost,
      fromSessionId: from.id,
      toName: targetVirtual?.remoteName ?? remoteSessionId,
      toHost: peer.host,
      toResolver,
      message,
    };
    link.send(dm);
  }

  private ackTo(peer: PeerState, messageId: string, delivered: boolean, reason?: string): void {
    const link = peer.outbound ?? peer.inbound;
    if (!link) return;
    link.send({
      type: "tailnet_delivery_ack",
      messageId,
      delivered,
      ...(reason ? { reason } : {}),
    });
  }

  private shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.error("[tailnet-relay] shutting down");
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    for (const peer of this.peers.values()) {
      peer.outbound?.close();
      peer.inbound?.close();
      for (const v of peer.virtualByRemoteId.values()) v.handle.close();
    }
    this.bridge?.close();
    this.server?.close();
    try { unlinkSync(RELAY_PID_PATH); } catch { /* PID file may not exist */ }
    process.exit(0);
  }
}

// Entry point when invoked directly (`tsx relay.ts`).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const config = loadTailnetConfig();
  const relay = new TailnetRelay(config);
  relay.start().catch((err) => {
    console.error("[tailnet-relay] start failed:", err);
    process.exit(1);
  });
}

// Silence unused-import warnings for the writeMessage we kept reserved.
void writeMessage;

export { TailnetRelay };
