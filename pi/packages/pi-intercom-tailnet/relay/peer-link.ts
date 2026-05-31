// One peer relay connection (TCP, framed JSON).
//
// Symmetric: we use the same code for inbound (`fromAcceptedSocket`)
// and outbound (`dial`) connections. After the hello exchange, frames
// flow in both directions for DMs and (later) channel gossip.

import net from "net";
import { EventEmitter } from "events";
import { writeMessage, createMessageReader } from "../framing.js";
import type { TailnetFrame, TailnetHello, TailnetDM, TailnetDeliveryAck, TailnetSessionList, TailnetSessionJoined, TailnetSessionLeft, SessionInfo } from "../types.js";

export interface PeerLinkOpts {
  /** Local host's MagicDNS short name; sent in the hello. */
  selfHost: string;
}

export interface DialOpts extends PeerLinkOpts {
  peerHost: string;
  peerIp: string;
  peerPort: number;
  connectTimeoutMs?: number;
}

export interface AcceptOpts extends PeerLinkOpts {
  socket: net.Socket;
  helloTimeoutMs?: number;
  /** Predicate run on the incoming hello; rejects the link if false. */
  acceptHello: (hello: TailnetHello, remoteAddress: string | undefined) => boolean;
}

interface PeerLinkEvents {
  /** Remote peer identified itself. Fires once per link. */
  ready: (remoteHost: string) => void;
  dm: (frame: TailnetDM) => void;
  ack: (frame: TailnetDeliveryAck) => void;
  sessionList: (sessions: SessionInfo[]) => void;
  sessionJoined: (session: SessionInfo) => void;
  sessionLeft: (sessionId: string) => void;
  closed: (err: Error | null) => void;
}

export interface PeerLink extends EventEmitter {
  on<E extends keyof PeerLinkEvents>(event: E, listener: PeerLinkEvents[E]): this;
  emit<E extends keyof PeerLinkEvents>(event: E, ...args: Parameters<PeerLinkEvents[E]>): boolean;
  readonly remoteHost: string | null;
  send(frame: TailnetFrame): void;
  close(): void;
}

function isHello(value: unknown): value is TailnetHello {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "tailnet_hello"
    && v.protocolVersion === 1
    && typeof v.host === "string"
    && v.host.length > 0;
}

function isDM(value: unknown): value is TailnetDM {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "tailnet_dm"
    && typeof v.fromName === "string"
    && typeof v.fromHost === "string"
    && typeof v.fromSessionId === "string"
    && typeof v.toName === "string"
    && typeof v.toHost === "string"
    && typeof v.toResolver === "object"
    && v.message !== undefined;
}

function isAck(value: unknown): value is TailnetDeliveryAck {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "tailnet_delivery_ack"
    && typeof v.messageId === "string"
    && typeof v.delivered === "boolean";
}

function isSessionList(value: unknown): value is TailnetSessionList {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "tailnet_sessions"
    && Array.isArray(v.sessions);
}

function isSessionJoined(value: unknown): value is TailnetSessionJoined {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "tailnet_session_joined"
    && v.session !== undefined;
}

function isSessionLeft(value: unknown): value is TailnetSessionLeft {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "tailnet_session_left"
    && typeof v.sessionId === "string";
}

function wireUp(
  socket: net.Socket,
  opts: PeerLinkOpts,
  setHello: (hello: TailnetHello) => boolean,
): PeerLink {
  const ee = new EventEmitter() as PeerLink;
  let remoteHost: string | null = null;
  let helloReceived = false;
  let closed = false;

  Object.defineProperty(ee, "remoteHost", {
    get: () => remoteHost,
  });

  const reader = createMessageReader(
    (raw) => {
      if (!helloReceived) {
        if (!isHello(raw)) {
          socket.destroy(new Error("Expected tailnet_hello"));
          return;
        }
        if (!setHello(raw)) {
          // Caller rejected the hello (allowlist, host mismatch, etc.).
          socket.destroy(new Error("Hello rejected"));
          return;
        }
        helloReceived = true;
        remoteHost = raw.host;
        // Defer so the caller can attach listeners before the event fires.
        setImmediate(() => ee.emit("ready", raw.host));
        return;
      }

      if (isDM(raw)) ee.emit("dm", raw);
      else if (isAck(raw)) ee.emit("ack", raw);
      else if (isSessionList(raw)) ee.emit("sessionList", raw.sessions);
      else if (isSessionJoined(raw)) ee.emit("sessionJoined", raw.session as SessionInfo);
      else if (isSessionLeft(raw)) ee.emit("sessionLeft", raw.sessionId);
      // Unknown frame types ignored (forward-compat).
    },
    (err) => {
      socket.destroy(err);
    },
  );

  socket.on("data", reader);
  socket.on("error", () => { /* surfaced via close */ });
  socket.on("close", () => {
    if (closed) return;
    closed = true;
    ee.emit("closed", null);
  });

  ee.send = (frame: TailnetFrame) => {
    if (closed) return;
    writeMessage(socket, frame);
  };

  ee.close = () => {
    if (closed) return;
    closed = true;
    socket.end();
  };

  return ee;
}

export function dialPeer(opts: DialOpts): Promise<PeerLink> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: opts.peerIp, port: opts.peerPort });
    const timeout = setTimeout(() => {
      socket.destroy(new Error("dial timeout"));
      reject(new Error(`Timed out dialing ${opts.peerHost} (${opts.peerIp}:${opts.peerPort})`));
    }, opts.connectTimeoutMs ?? 5000);

    socket.once("connect", () => {
      clearTimeout(timeout);
      writeMessage(socket, {
        type: "tailnet_hello",
        protocolVersion: 1,
        host: opts.selfHost,
      } as TailnetHello);

      // Build the link AFTER our hello has been sent.
      const link = wireUp(socket, opts, (remoteHello) => {
        // The remote can advertise any host; we trust Tailscale + caller
        // ACLs to have authenticated this connection. Mismatch with the
        // host we *intended* to dial is suspicious, so reject it.
        return remoteHello.host.toLowerCase() === opts.peerHost.toLowerCase();
      });

      link.once("ready", () => resolve(link));
      link.once("closed", () => reject(new Error(`Peer ${opts.peerHost} closed before hello`)));
    });

    socket.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export function acceptPeer(opts: AcceptOpts): PeerLink {
  const helloTimer = setTimeout(() => {
    opts.socket.destroy(new Error("hello timeout"));
  }, opts.helloTimeoutMs ?? 5000);

  const link = wireUp(opts.socket, opts, (hello) => {
    clearTimeout(helloTimer);
    return opts.acceptHello(hello, opts.socket.remoteAddress);
  });

  // Reply with our hello once the link is wired up. Order doesn't matter:
  // both sides parse the other's hello before any DM frame.
  writeMessage(opts.socket, {
    type: "tailnet_hello",
    protocolVersion: 1,
    host: opts.selfHost,
  } as TailnetHello);

  link.once("closed", () => clearTimeout(helloTimer));
  return link;
}
