// Bridge to the local pi-intercom broker.
//
// One control connection (read-only consumer of session join/leave +
// `list` requests) + N virtual-session connections (one per remote
// session we expose locally as "<name>@<host>"). The broker enforces
// one-session-per-connection so multiplexing happens at the TCP level.

import net from "net";
import { EventEmitter } from "events";
import { writeMessage, createMessageReader, isSocketBackedUp } from "../framing.js";
import type { IntercomMessage, SessionInfo } from "../types.js";

/** Outcome of sending a DM out through a virtual session. */
export interface SendResult {
  delivered: boolean;
  reason?: string;
}

// How long to wait for the broker's delivered/delivery_failed reply before
// reporting the send as failed (so a wedged broker can't hang the ack path).
const SEND_ACK_TIMEOUT_MS = 10_000;

export interface BrokerBridgeOpts {
  socketPath: string;
  controlName?: string;     // session name advertised by the control socket
  controlCwd?: string;
  controlModel?: string;
  pid: number;
}

export interface VirtualSessionInit {
  /** Local display name (e.g. "worker@nimbus"). */
  displayName: string;
  cwd: string;
  model: string;            // e.g. "tailnet:nimbus"
  /** Called when the broker delivers a `message` addressed at this virtual session. */
  onMessage: (from: SessionInfo, message: IntercomMessage) => void;
  /**
   * Called when the broker drops this virtual session's connection without the
   * relay asking (eviction, broker restart). NOT called for a relay-initiated
   * close() — that path is intentional teardown.
   */
  onClose?: () => void;
}

export interface VirtualSessionHandle {
  /** Broker-assigned id once registration completes. */
  sessionId: Promise<string>;
  /**
   * Send a DM from this virtual session into the broker. Resolves with the
   * broker's actual delivery outcome (delivered / delivery_failed), or a
   * failure if the broker doesn't reply in time or the socket is backed up.
   */
  send(to: string, message: IntercomMessage): Promise<SendResult>;
  close(): void;
}

interface BridgeEvents {
  /** A non-relay local session joined. */
  localSessionJoined: (info: SessionInfo) => void;
  /** A local session left. */
  localSessionLeft: (sessionId: string) => void;
  /** Local session list refreshed (full snapshot). */
  localSessions: (sessions: SessionInfo[]) => void;
  /** Control connection lost. */
  controlClosed: (err: Error | null) => void;
}

export interface BrokerBridge extends EventEmitter {
  on<E extends keyof BridgeEvents>(event: E, listener: BridgeEvents[E]): this;
  emit<E extends keyof BridgeEvents>(event: E, ...args: Parameters<BridgeEvents[E]>): boolean;
  /** Open the control socket and resolve once registered. */
  start(): Promise<void>;
  /** Trigger a full `list` refresh of local sessions. */
  refreshLocalSessions(): Promise<SessionInfo[]>;
  /** Open a virtual session connection. */
  openVirtualSession(init: VirtualSessionInit): VirtualSessionHandle;
  /** Tear everything down. */
  close(): void;
}

export function createBrokerBridge(opts: BrokerBridgeOpts): BrokerBridge {
  const ee = new EventEmitter() as BrokerBridge;
  let controlSocket: net.Socket | null = null;
  let controlReady = false;
  let closed = false;

  const pendingLists = new Map<string, (sessions: SessionInfo[]) => void>();

  function handleControlFrame(raw: unknown): void {
    if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
    const m = raw as { type: string } & Record<string, unknown>;
    switch (m.type) {
      case "registered": {
        controlReady = true;
        break;
      }
      case "session_joined": {
        if (m.session) ee.emit("localSessionJoined", m.session as SessionInfo);
        break;
      }
      case "session_left": {
        if (typeof m.sessionId === "string") ee.emit("localSessionLeft", m.sessionId);
        break;
      }
      case "sessions": {
        if (typeof m.requestId === "string" && Array.isArray(m.sessions)) {
          const resolver = pendingLists.get(m.requestId);
          if (resolver) {
            pendingLists.delete(m.requestId);
            resolver(m.sessions as SessionInfo[]);
          }
          ee.emit("localSessions", m.sessions as SessionInfo[]);
        }
        break;
      }
    }
  }

  ee.start = function start(): Promise<void> {
    if (controlSocket) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(opts.socketPath);
      controlSocket = sock;

      const reader = createMessageReader(
        (msg) => {
          handleControlFrame(msg);
          if (!controlReady) return;
        },
        (err) => {
          sock.destroy(err);
        },
      );
      sock.on("data", reader);

      sock.once("error", (err) => {
        if (!controlReady) reject(err);
      });

      sock.on("close", () => {
        ee.emit("controlClosed", null);
      });

      sock.on("connect", () => {
        const now = Date.now();
        writeMessage(sock, {
          type: "register",
          session: {
            name: opts.controlName ?? "__tailnet_relay__",
            cwd: opts.controlCwd ?? process.cwd(),
            model: opts.controlModel ?? "tailnet:relay",
            pid: opts.pid,
            startedAt: now,
            lastActivity: now,
            status: "relay:control",
          },
        });
        // Treat connect+register as "ready" for the resolve. registered
        // arrives on a subsequent frame; we resolve early so callers can
        // start preparing virtual sessions in parallel.
        resolve();
      });
    });
  };

  ee.refreshLocalSessions = function refreshLocalSessions(): Promise<SessionInfo[]> {
    return new Promise((resolve, reject) => {
      if (!controlSocket) {
        reject(new Error("Control socket not started"));
        return;
      }
      const requestId = `list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pendingLists.set(requestId, resolve);
      setTimeout(() => {
        if (pendingLists.delete(requestId)) {
          reject(new Error(`list request ${requestId} timed out`));
        }
      }, 5000);
      writeMessage(controlSocket, { type: "list", requestId });
    });
  };

  ee.openVirtualSession = function openVirtualSession(init: VirtualSessionInit): VirtualSessionHandle {
    const sock = net.createConnection(opts.socketPath);
    let vClosed = false;
    let resolveId: (id: string) => void = () => {};
    let rejectId: (err: Error) => void = () => {};
    const sessionId = new Promise<string>((res, rej) => {
      resolveId = res;
      rejectId = rej;
    });
    // Pending DM sends awaiting the broker's delivered/delivery_failed reply,
    // keyed by message id.
    const pendingSends = new Map<string, (result: SendResult) => void>();
    const settlePending = (messageId: string, result: SendResult): void => {
      const resolver = pendingSends.get(messageId);
      if (resolver) {
        pendingSends.delete(messageId);
        resolver(result);
      }
    };
    const failAllPending = (reason: string): void => {
      for (const [, resolver] of pendingSends) resolver({ delivered: false, reason });
      pendingSends.clear();
    };

    const reader = createMessageReader(
      (raw) => {
        if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
        const m = raw as { type: string } & Record<string, unknown>;
        switch (m.type) {
          case "registered": {
            if (typeof m.sessionId === "string") resolveId(m.sessionId);
            break;
          }
          case "message": {
            if (m.from && m.message) {
              init.onMessage(m.from as SessionInfo, m.message as IntercomMessage);
            }
            break;
          }
          case "delivered": {
            if (typeof m.messageId === "string") settlePending(m.messageId, { delivered: true });
            break;
          }
          case "delivery_failed": {
            if (typeof m.messageId === "string") {
              settlePending(m.messageId, {
                delivered: false,
                reason: typeof m.reason === "string" ? m.reason : "delivery failed",
              });
            }
            break;
          }
        }
      },
      (err) => sock.destroy(err),
    );
    sock.on("data", reader);

    sock.on("error", (err) => {
      if (!vClosed) rejectId(err);
    });

    sock.on("close", () => {
      failAllPending("virtual session connection closed");
      // Only fires for a broker-initiated drop: a relay-initiated close() sets
      // vClosed first, so this no-ops there and won't double-report.
      if (vClosed) return;
      vClosed = true;
      init.onClose?.();
    });

    sock.on("connect", () => {
      const now = Date.now();
      writeMessage(sock, {
        type: "register",
        session: {
          name: init.displayName,
          cwd: init.cwd,
          model: init.model,
          pid: opts.pid,
          startedAt: now,
          lastActivity: now,
          status: "tailnet:bridged",
        },
      });
    });

    return {
      sessionId,
      send(to: string, message: IntercomMessage): Promise<SendResult> {
        if (vClosed) return Promise.resolve({ delivered: false, reason: "virtual session closed" });
        if (isSocketBackedUp(sock)) {
          return Promise.resolve({ delivered: false, reason: "local broker not draining" });
        }
        const messageId = message.id;
        return new Promise<SendResult>((resolve) => {
          const timer = setTimeout(() => {
            if (pendingSends.delete(messageId)) {
              resolve({ delivered: false, reason: "broker delivery timeout" });
            }
          }, SEND_ACK_TIMEOUT_MS);
          pendingSends.set(messageId, (result) => {
            clearTimeout(timer);
            resolve(result);
          });
          try {
            writeMessage(sock, { type: "send", to, message });
          } catch (err) {
            clearTimeout(timer);
            pendingSends.delete(messageId);
            resolve({ delivered: false, reason: err instanceof Error ? err.message : String(err) });
          }
        });
      },
      close(): void {
        if (vClosed) return;
        vClosed = true;
        failAllPending("virtual session closed");
        try { writeMessage(sock, { type: "unregister" }); } catch { /* socket already dead */ }
        sock.end();
      },
    };
  };

  ee.close = function close(): void {
    if (closed) return;
    closed = true;
    if (controlSocket) {
      try { writeMessage(controlSocket, { type: "unregister" }); } catch { /* ignore */ }
      controlSocket.end();
      controlSocket = null;
    }
  };

  return ee;
}
