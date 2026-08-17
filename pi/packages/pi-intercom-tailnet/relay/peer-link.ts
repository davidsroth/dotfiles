// One peer relay connection (TCP, framed JSON).
//
// Symmetric: we use the same code for inbound (`fromAcceptedSocket`)
// and outbound (`dial`) connections. After the hello exchange, frames
// flow in both directions for DMs and (later) channel gossip.

import net from "net";
import { EventEmitter } from "events";
import { writeMessage, createMessageReader, isSocketBackedUp } from "../framing.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optional(value: Record<string, unknown>, key: string, check: (item: unknown) => boolean): boolean {
  return value[key] === undefined || check(value[key]);
}

function isAttachment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.type === "file" || value.type === "snippet" || value.type === "context")
    && isNonEmptyString(value.name)
    && typeof value.content === "string"
    && optional(value, "language", (item) => typeof item === "string");
}

function isMessage(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !Number.isFinite(value.timestamp)) return false;
  if (!isRecord(value.content) || typeof value.content.text !== "string") return false;
  if (!optional(value.content, "attachments", (items) => Array.isArray(items) && items.every(isAttachment))) return false;
  for (const key of ["senderSequence", "brokerReceivedAt", "brokerDeliveredAt", "receiverReceivedAt", "injectedAt"]) {
    if (!optional(value, key, Number.isFinite)) return false;
  }
  for (const key of ["supersedes", "retryOf", "replyTo", "replyError"]) {
    if (!optional(value, key, (item) => typeof item === "string")) return false;
  }
  return optional(value, "expectsReply", (item) => typeof item === "boolean")
    && optional(value, "aside", (item) => typeof item === "boolean");
}

function isSession(value: unknown): value is SessionInfo {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id) || typeof value.cwd !== "string" || typeof value.model !== "string") return false;
  if (!Number.isFinite(value.pid) || !Number.isFinite(value.startedAt) || !Number.isFinite(value.lastActivity)) return false;
  for (const key of ["name", "status"]) {
    if (!optional(value, key, (item) => typeof item === "string")) return false;
  }
  for (const key of ["peerUid", "contextPct", "contextTokens", "contextWindow"]) {
    if (!optional(value, key, Number.isFinite)) return false;
  }
  return optional(value, "trustedLocal", (item) => typeof item === "boolean")
    && optional(value, "features", (items) => Array.isArray(items) && items.every((item) => typeof item === "string"));
}

function isHello(value: unknown): value is TailnetHello {
  if (!isRecord(value)) return false;
  return value.type === "tailnet_hello"
    && value.protocolVersion === 1
    && isNonEmptyString(value.host)
    && optional(value, "features", (items) => Array.isArray(items) && items.every((item) => typeof item === "string"));
}

/** Validate untrusted direct-message frames before dispatching to relay listeners. */
export function isTailnetDM(value: unknown): value is TailnetDM {
  if (!isRecord(value)) return false;
  const resolver = value.toResolver;
  const validResolver = isRecord(resolver)
    && ((resolver.kind === "name" && isNonEmptyString(resolver.name))
      || (resolver.kind === "sessionId" && isNonEmptyString(resolver.id)));
  return value.type === "tailnet_dm"
    && isNonEmptyString(value.fromName)
    && isNonEmptyString(value.fromHost)
    && isNonEmptyString(value.fromSessionId)
    && isNonEmptyString(value.toName)
    && isNonEmptyString(value.toHost)
    && validResolver
    && isMessage(value.message);
}

function isAck(value: unknown): value is TailnetDeliveryAck {
  if (!isRecord(value)) return false;
  return value.type === "tailnet_delivery_ack"
    && isNonEmptyString(value.messageId)
    && typeof value.delivered === "boolean"
    && optional(value, "reason", (item) => typeof item === "string");
}

function isSessionList(value: unknown): value is TailnetSessionList {
  return isRecord(value)
    && value.type === "tailnet_sessions"
    && Array.isArray(value.sessions)
    && value.sessions.every(isSession);
}

function isSessionJoined(value: unknown): value is TailnetSessionJoined {
  return isRecord(value)
    && value.type === "tailnet_session_joined"
    && isSession(value.session);
}

function isSessionLeft(value: unknown): value is TailnetSessionLeft {
  return isRecord(value)
    && value.type === "tailnet_session_left"
    && isNonEmptyString(value.sessionId);
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

      if (isTailnetDM(raw)) ee.emit("dm", raw);
      else if (isAck(raw)) ee.emit("ack", raw);
      else if (isSessionList(raw)) ee.emit("sessionList", raw.sessions);
      else if (isSessionJoined(raw)) ee.emit("sessionJoined", raw.session);
      else if (isSessionLeft(raw)) ee.emit("sessionLeft", raw.sessionId);
      else if (isRecord(raw) && typeof raw.type === "string" && raw.type.startsWith("tailnet_")) {
        // Known protocol namespace frames must be valid before they reach an
        // EventEmitter listener. Unknown future namespaces remain ignorable.
        socket.destroy(new Error(`Invalid ${raw.type} frame`));
      }
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
    // Bound memory: if the remote peer isn't draining what we've written, the
    // link is wedged — tear it down (the close handler cleans up) rather than
    // buffer without limit. An oversized frame likewise tears down this link
    // instead of escaping into the reader's error path.
    if (isSocketBackedUp(socket)) {
      socket.destroy(new Error("peer outbound buffer exceeded"));
      return;
    }
    try {
      writeMessage(socket, frame);
    } catch (err) {
      socket.destroy(err instanceof Error ? err : new Error(String(err)));
    }
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
