// Bridge to the local pi-intercom v0.9.2 broker.

import net from "net";
import { EventEmitter } from "events";
import {
  BROKER_MAX_FRAME_BYTES,
  createMessageReader,
  isSocketBackedUp,
  writeMessage,
} from "../framing.js";
import type { IntercomMessage, SessionInfo, SessionRegistration } from "../types.js";

/** The deliberately minimal broker writer allowlist (ADR 0001). */
export const SHARED_BROKER_CLIENT_MESSAGE_TYPES = [
  "register",
  "list",
  "send",
  "unregister",
] as const;

export type SharedBrokerClientMessageType =
  (typeof SHARED_BROKER_CLIENT_MESSAGE_TYPES)[number];

const SHARED_TYPE_SET: ReadonlySet<string> = new Set(SHARED_BROKER_CLIENT_MESSAGE_TYPES);

export function writeBrokerFrame(
  socket: net.Socket,
  frame: { type: SharedBrokerClientMessageType } & Record<string, unknown>,
): void {
  if (!SHARED_TYPE_SET.has(frame.type)) {
    throw new Error(
      `[pi-intercom-tailnet] refusing to send broker frame of type "${frame.type}": `
        + `not in the minimal broker subset (${SHARED_BROKER_CLIENT_MESSAGE_TYPES.join(", ")}). `
        + "See docs/adr/0001-dual-broker-compatibility.md.",
    );
  }
  writeMessage(socket, frame, BROKER_MAX_FRAME_BYTES, "local broker");
}

export interface SendResult {
  delivered: boolean;
  reason?: string;
}

const SEND_ACK_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 5_000;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 5_000;

export interface BrokerBridgeOpts {
  socketPath: string;
  /** Stable top-level v0.9 registration ID for this host's control session. */
  controlSessionId: string;
  controlName?: string;
  controlCwd?: string;
  controlModel?: string;
  pid: number;
  registrationTimeoutMs?: number;
}

export interface VirtualSessionInit {
  /** Stable top-level v0.9 registration ID derived from peer + remote ID. */
  sessionId: string;
  displayName: string;
  cwd: string;
  model: string;
  /** Capabilities of the represented remote session (for example aside-v1). */
  features?: string[];
  onMessage: (from: SessionInfo, message: IntercomMessage) => void;
  onClose?: () => void;
}

export interface VirtualSessionHandle {
  sessionId: Promise<string>;
  send(to: string, message: IntercomMessage): Promise<SendResult>;
  close(): void;
}

interface BridgeEvents {
  localSessionJoined: (info: SessionInfo) => void;
  localSessionLeft: (sessionId: string) => void;
  localSessions: (sessions: SessionInfo[]) => void;
  controlClosed: (err: Error | null) => void;
}

export interface BrokerBridge extends EventEmitter {
  on<E extends keyof BridgeEvents>(event: E, listener: BridgeEvents[E]): this;
  emit<E extends keyof BridgeEvents>(event: E, ...args: Parameters<BridgeEvents[E]>): boolean;
  /** Features from the control connection's registered frame. */
  readonly brokerFeatures: ReadonlySet<string>;
  start(): Promise<void>;
  refreshLocalSessions(): Promise<SessionInfo[]>;
  openVirtualSession(init: VirtualSessionInit): VirtualSessionHandle;
  close(): void;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createBrokerBridge(opts: BrokerBridgeOpts): BrokerBridge {
  const ee = new EventEmitter() as BrokerBridge;
  let controlSocket: net.Socket | null = null;
  let controlStart: Promise<void> | null = null;
  let controlReady = false;
  let closed = false;
  let brokerFeatures = new Set<string>();
  const registrationTimeoutMs = opts.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
  const virtualClosers = new Set<() => void>();

  Object.defineProperty(ee, "brokerFeatures", {
    get: () => brokerFeatures as ReadonlySet<string>,
    enumerable: true,
  });

  const pendingLists = new Map<string, {
    resolve: (sessions: SessionInfo[]) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  const failPendingLists = (error: Error): void => {
    for (const pending of pendingLists.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingLists.clear();
  };

  ee.start = function start(): Promise<void> {
    if (closed) return Promise.reject(new Error("Broker bridge closed"));
    if (controlStart) return controlStart;

    controlStart = new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(opts.socketPath);
      controlSocket = sock;
      let settled = false;
      let closeError: Error | null = null;
      const registrationTimer = setTimeout(() => {
        const error = new Error("Control registration timed out");
        closeError = error;
        if (!settled) {
          settled = true;
          reject(error);
        }
        sock.destroy(error);
      }, registrationTimeoutMs);

      const settleRegistered = (frame: Record<string, unknown>): void => {
        if (typeof frame.sessionId !== "string") {
          throw new Error("Invalid registered frame");
        }
        if (frame.sessionId !== opts.controlSessionId) {
          throw new Error(`Broker returned unexpected control sessionId ${frame.sessionId}`);
        }
        if (
          frame.features !== undefined
          && (!Array.isArray(frame.features) || !frame.features.every((v) => typeof v === "string"))
        ) {
          throw new Error("Invalid registered features");
        }
        controlReady = true;
        brokerFeatures = new Set((frame.features as string[] | undefined) ?? []);
        clearTimeout(registrationTimer);
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const reader = createMessageReader(
        (raw) => {
          if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
          const m = raw as { type: string } & Record<string, unknown>;
          if (!controlReady && m.type !== "registered" && m.type !== "error") {
            throw new Error(`Received ${m.type} before registered`);
          }
          switch (m.type) {
            case "registered":
              settleRegistered(m);
              break;
            case "error": {
              const error = new Error(typeof m.error === "string" ? m.error : "Broker error");
              closeError = error;
              if (!settled) {
                settled = true;
                clearTimeout(registrationTimer);
                reject(error);
              }
              failPendingLists(error);
              sock.destroy(error);
              break;
            }
            case "session_joined":
              if (m.session) ee.emit("localSessionJoined", m.session as SessionInfo);
              break;
            case "session_left":
              if (typeof m.sessionId === "string") ee.emit("localSessionLeft", m.sessionId);
              break;
            case "sessions": {
              if (typeof m.requestId !== "string" || !Array.isArray(m.sessions)) break;
              const pending = pendingLists.get(m.requestId);
              if (pending) {
                pendingLists.delete(m.requestId);
                clearTimeout(pending.timer);
                pending.resolve(m.sessions as SessionInfo[]);
              }
              ee.emit("localSessions", m.sessions as SessionInfo[]);
              break;
            }
          }
        },
        (error) => {
          closeError = error;
          sock.destroy(error);
        },
        BROKER_MAX_FRAME_BYTES,
        "local broker",
      );
      sock.on("data", reader);
      sock.on("error", (error) => { closeError = error; });
      sock.on("close", () => {
        clearTimeout(registrationTimer);
        controlReady = false;
        brokerFeatures = new Set();
        if (controlSocket === sock) controlSocket = null;
        const error = closeError ?? new Error("Control connection closed");
        if (!settled) {
          settled = true;
          reject(error);
        }
        failPendingLists(error);
        if (!closed) ee.emit("controlClosed", closeError);
      });
      sock.on("connect", () => {
        const now = Date.now();
        const session: SessionRegistration = {
          name: opts.controlName ?? "__tailnet_relay__",
          cwd: opts.controlCwd ?? process.cwd(),
          model: opts.controlModel ?? "tailnet:relay",
          pid: opts.pid,
          startedAt: now,
          lastActivity: now,
          status: "relay:control",
        };
        try {
          writeBrokerFrame(sock, {
            type: "register",
            session,
            sessionId: opts.controlSessionId,
          });
        } catch (error) {
          closeError = toError(error);
          sock.destroy(closeError);
        }
      });
    });

    return controlStart;
  };

  ee.refreshLocalSessions = async function refreshLocalSessions(): Promise<SessionInfo[]> {
    await ee.start();
    const socket = controlSocket;
    if (!socket || !controlReady || socket.destroyed) throw new Error("Control socket not registered");
    const requestId = `list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<SessionInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingLists.delete(requestId)) reject(new Error(`list request ${requestId} timed out`));
      }, LIST_TIMEOUT_MS);
      pendingLists.set(requestId, { resolve, reject, timer });
      try {
        writeBrokerFrame(socket, { type: "list", requestId });
      } catch (error) {
        clearTimeout(timer);
        pendingLists.delete(requestId);
        reject(toError(error));
      }
    });
  };

  ee.openVirtualSession = function openVirtualSession(init: VirtualSessionInit): VirtualSessionHandle {
    const sock = net.createConnection(opts.socketPath);
    let intentionalClose = false;
    let registered = false;
    let registrationSettled = false;
    let closeError: Error | null = null;
    let resolveId!: (id: string) => void;
    let rejectId!: (error: Error) => void;
    const sessionId = new Promise<string>((resolve, reject) => {
      resolveId = resolve;
      rejectId = reject;
    });
    const registrationTimer = setTimeout(() => {
      const error = new Error(`Virtual session ${init.sessionId} registration timed out`);
      closeError = error;
      if (!registrationSettled) {
        registrationSettled = true;
        rejectId(error);
      }
      sock.destroy(error);
    }, registrationTimeoutMs);

    const pendingSends = new Map<string, {
      resolve: (result: SendResult) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }>();
    const failAllPending = (error: Error): void => {
      for (const pending of pendingSends.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      pendingSends.clear();
    };
    const settlePending = (messageId: string, result: SendResult): void => {
      const pending = pendingSends.get(messageId);
      if (!pending) return;
      pendingSends.delete(messageId);
      clearTimeout(pending.timer);
      pending.resolve(result);
    };

    const reader = createMessageReader(
      (raw) => {
        if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
        const m = raw as { type: string } & Record<string, unknown>;
        if (!registered && m.type !== "registered" && m.type !== "error") {
          throw new Error(`Received ${m.type} before registered`);
        }
        switch (m.type) {
          case "registered": {
            if (typeof m.sessionId !== "string" || m.sessionId !== init.sessionId) {
              throw new Error("Broker returned unexpected virtual sessionId");
            }
            registered = true;
            clearTimeout(registrationTimer);
            if (!registrationSettled) {
              registrationSettled = true;
              resolveId(m.sessionId);
            }
            break;
          }
          case "error": {
            const error = new Error(typeof m.error === "string" ? m.error : "Broker error");
            closeError = error;
            if (!registrationSettled) {
              registrationSettled = true;
              clearTimeout(registrationTimer);
              rejectId(error);
            }
            failAllPending(error);
            sock.destroy(error);
            break;
          }
          case "message":
            if (m.from && m.message) init.onMessage(m.from as SessionInfo, m.message as IntercomMessage);
            break;
          case "delivered":
            if (typeof m.messageId === "string") settlePending(m.messageId, { delivered: true });
            break;
          case "delivery_failed":
            if (typeof m.messageId === "string") {
              settlePending(m.messageId, {
                delivered: false,
                reason: typeof m.reason === "string" ? m.reason : "delivery failed",
              });
            }
            break;
        }
      },
      (error) => {
        closeError = error;
        sock.destroy(error);
      },
      BROKER_MAX_FRAME_BYTES,
      "local broker",
    );
    sock.on("data", reader);
    sock.on("error", (error) => { closeError = error; });
    sock.on("close", () => {
      clearTimeout(registrationTimer);
      const error = closeError ?? new Error("Virtual session connection closed");
      if (!registrationSettled) {
        registrationSettled = true;
        rejectId(error);
      }
      failAllPending(error);
      virtualClosers.delete(closeVirtual);
      if (!intentionalClose) init.onClose?.();
    });
    sock.on("connect", () => {
      const now = Date.now();
      const session: SessionRegistration = {
        name: init.displayName,
        cwd: init.cwd,
        model: init.model,
        pid: opts.pid,
        startedAt: now,
        lastActivity: now,
        status: "tailnet:bridged",
        ...(init.features?.length ? { features: [...init.features] } : {}),
      };
      try {
        writeBrokerFrame(sock, {
          type: "register",
          session,
          sessionId: init.sessionId,
        });
      } catch (error) {
        closeError = toError(error);
        sock.destroy(closeError);
      }
    });

    const closeVirtual = (): void => {
      if (intentionalClose) return;
      intentionalClose = true;
      clearTimeout(registrationTimer);
      const error = new Error("Virtual session closed");
      if (!registrationSettled) {
        registrationSettled = true;
        rejectId(error);
      }
      failAllPending(error);
      virtualClosers.delete(closeVirtual);
      if (registered && !sock.destroyed) {
        try { writeBrokerFrame(sock, { type: "unregister" }); } catch { /* already dead */ }
        sock.end();
      } else {
        sock.destroy();
      }
    };
    virtualClosers.add(closeVirtual);

    return {
      sessionId,
      async send(to: string, message: IntercomMessage): Promise<SendResult> {
        await sessionId;
        if (intentionalClose || sock.destroyed || !registered) throw new Error("Virtual session closed");
        if (isSocketBackedUp(sock)) throw new Error("Local broker not draining");
        return new Promise<SendResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (pendingSends.delete(message.id)) reject(new Error("Broker delivery timeout"));
          }, SEND_ACK_TIMEOUT_MS);
          pendingSends.set(message.id, { resolve, reject, timer });
          try {
            writeBrokerFrame(sock, { type: "send", to, message });
          } catch (error) {
            clearTimeout(timer);
            pendingSends.delete(message.id);
            reject(toError(error));
          }
        });
      },
      close: closeVirtual,
    };
  };

  ee.close = function close(): void {
    if (closed) return;
    closed = true;
    const error = new Error("Broker bridge closed");
    failPendingLists(error);
    for (const closeVirtual of [...virtualClosers]) closeVirtual();
    if (controlSocket) {
      if (controlReady && !controlSocket.destroyed) {
        try { writeBrokerFrame(controlSocket, { type: "unregister" }); } catch { /* already dead */ }
        controlSocket.end();
      } else {
        controlSocket.destroy();
      }
      controlSocket = null;
    }
  };

  return ee;
}
