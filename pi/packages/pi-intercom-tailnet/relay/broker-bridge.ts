// Bridge to the local pi-intercom broker.
//
// One control connection (read-only consumer of session join/leave +
// `list` requests) + N virtual-session connections (one per remote
// session we expose locally as "<name>@<host>"). The broker enforces
// one-session-per-connection so multiplexing happens at the TCP level.

import net from "net";
import { EventEmitter } from "events";
import { writeMessage, createMessageReader } from "../framing.js";
import type { IntercomMessage, SessionInfo } from "../types.js";

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
}

export interface VirtualSessionHandle {
  /** Broker-assigned id once registration completes. */
  sessionId: Promise<string>;
  /** Send a frame from this virtual session into the broker (DM out). */
  send(to: string, message: IntercomMessage): void;
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
        }
      },
      (err) => sock.destroy(err),
    );
    sock.on("data", reader);

    sock.on("error", (err) => {
      if (!vClosed) rejectId(err);
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
      send(to: string, message: IntercomMessage): void {
        if (vClosed) return;
        writeMessage(sock, { type: "send", to, message });
      },
      close(): void {
        if (vClosed) return;
        vClosed = true;
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
