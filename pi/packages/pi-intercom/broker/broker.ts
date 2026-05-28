import net from "net";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.js";
import { getBrokerSocketPath } from "./paths.js";
import type { SessionInfo, Message, Attachment, BrokerMessage } from "../types.js";

const INTERCOM_DIR = join(homedir(), ".pi/agent/intercom");
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
}

interface SessionLookup {
  targets: ConnectedSession[];
  match: "id" | "name" | "idPrefix" | "none";
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const attachment = value as Record<string, unknown>;

  if (
    attachment.type !== "file"
    && attachment.type !== "snippet"
    && attachment.type !== "context"
  ) {
    return false;
  }

  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") {
    return false;
  }

  return attachment.language === undefined || typeof attachment.language === "string";
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  if (typeof message.id !== "string" || typeof message.timestamp !== "number") {
    return false;
  }

  if (message.replyTo !== undefined && typeof message.replyTo !== "string") {
    return false;
  }

  if (message.expectsReply !== undefined && typeof message.expectsReply !== "boolean") {
    return false;
  }

  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }

  const content = message.content as Record<string, unknown>;
  if (typeof content.text !== "string") {
    return false;
  }

  return content.attachments === undefined
    || (Array.isArray(content.attachments) && content.attachments.every(isAttachment));
}

function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const session = value as Record<string, unknown>;

  if (
    typeof session.cwd !== "string"
    || typeof session.model !== "string"
    || typeof session.pid !== "number"
    || typeof session.startedAt !== "number"
    || typeof session.lastActivity !== "number"
  ) {
    return false;
  }

  if (session.name !== undefined && typeof session.name !== "string") {
    return false;
  }

  if (session.originSessionId !== undefined && typeof session.originSessionId !== "string") {
    return false;
  }

  return session.status === undefined || typeof session.status === "string";
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;

  constructor() {
    mkdirSync(INTERCOM_DIR, { recursive: true });
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // A clean startup has no stale socket to remove.
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    this.server.listen(SOCKET_PATH, () => {
      writeFileSync(PID_PATH, String(process.pid));
      console.log(`Intercom broker started (pid: ${process.pid})`);
    });
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    const cleanupRegisteredSession = (): void => {
      if (!sessionId) {
        return;
      }
      const id = sessionId;
      sessionId = null;
      if (this.sessions.delete(id)) {
        this.broadcast({ type: "session_left", sessionId: id }, id);
        this.scheduleShutdownCheck();
      }
    };

    const reader = createMessageReader((msg) => {
      this.handleMessage(socket, msg, sessionId, (id) => {
        sessionId = id;
      });
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);
    socket.on("close", cleanupRegisteredSession);

    socket.on("error", (error) => {
      console.error("Socket error:", error);
      cleanupRegisteredSession();
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5000);
  }

  private handleMessage(
    socket: net.Socket,
    msg: unknown,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }

    const clientMessage = msg as { type: string } & Record<string, unknown>;

    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }

        if (currentId) {
          throw new Error("Received duplicate register message");
        }

        // Evict any prior registration from the same pi session. When a
        // session reconnects (transient drop or broker restart) it registers
        // with a fresh UUID; the old row is only cleaned when its previous
        // socket emits `close`, which does not always fire. Keying eviction on
        // the stable originSessionId removes the duplicate immediately, even
        // when the stale socket still looks writable.
        const originSessionId = clientMessage.session.originSessionId;
        if (originSessionId) {
          const superseded = Array.from(this.sessions.values()).filter(
            existing => existing.info.originSessionId === originSessionId && existing.socket !== socket,
          );
          for (const existing of superseded) {
            this.removeSession(existing.info.id, "superseded by reconnect");
          }
        }

        const id = randomUUID();
        setId(id);
        const info: SessionInfo = { ...clientMessage.session, id };
        this.sessions.set(id, { socket, info });
        
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        writeMessage(socket, { type: "registered", sessionId: id });
        this.broadcast({ type: "session_joined", session: info }, id);
        break;
      }

      case "unregister": {
        this.sessions.delete(currentId);
        this.broadcast({ type: "session_left", sessionId: currentId }, currentId);
        setId(null);
        this.scheduleShutdownCheck();
        break;
      }

      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }

        const sessions = Array.from(this.sessions.values()).map(s => s.info);
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }

      case "send": {
        const message = clientMessage.message;
        const messageId = isMessage(message) ? message.id : "unknown";

        if (typeof clientMessage.to !== "string" || !isMessage(message)) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId,
            reason: "Invalid message format",
          });
          break;
        }

        const lookup = this.findSessions(clientMessage.to);
        const targets = lookup.targets;
        if (targets.length === 1) {
          const target = targets[0];
          const fromSession = this.sessions.get(currentId);
          if (!fromSession) {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Sender session not found",
            });
            break;
          }
          if (!this.isSocketWritable(target.socket)) {
            this.removeSession(target.info.id, "Session disconnected");
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Session disconnected",
            });
            break;
          }
          try {
            writeMessage(target.socket, {
              type: "message",
              from: fromSession.info,
              message,
            });
          } catch {
            this.removeSession(target.info.id, "Session disconnected");
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Session disconnected",
            });
            break;
          }
          writeMessage(socket, { type: "delivered", messageId: message.id });
          break;
        }

        if (targets.length > 1) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: message.id,
            reason: lookup.match === "idPrefix"
              ? `Multiple sessions match ID prefix \"${clientMessage.to}\". Use the full session ID instead.`
              : `Multiple sessions named \"${clientMessage.to}\" are connected. Use the session ID instead.`,
          });
          break;
        }

        writeMessage(socket, {
          type: "delivery_failed",
          messageId: message.id,
          reason: "Session not found",
        });
        break;
      }

      case "presence": {
        const session = this.sessions.get(currentId);
        if (session) {
          if (clientMessage.name !== undefined) {
            if (typeof clientMessage.name !== "string") {
              throw new Error("Invalid presence name");
            }
            session.info.name = clientMessage.name;
          }
          if (clientMessage.status !== undefined) {
            if (typeof clientMessage.status !== "string") {
              throw new Error("Invalid presence status");
            }
            session.info.status = clientMessage.status;
          }
          if (clientMessage.model !== undefined) {
            if (typeof clientMessage.model !== "string") {
              throw new Error("Invalid presence model");
            }
            session.info.model = clientMessage.model;
          }
          session.info.lastActivity = Date.now();
          this.broadcast({ type: "presence_update", session: session.info }, currentId);
        }
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  private findSessions(nameOrId: string): SessionLookup {
    const target = nameOrId.trim();
    if (!target) {
      return { targets: [], match: "none" };
    }

    const byId = this.sessions.get(target);
    if (byId) {
      return { targets: [byId], match: "id" };
    }

    const lowerTarget = target.toLowerCase();
    const byName = Array.from(this.sessions.values()).filter(session => session.info.name?.toLowerCase() === lowerTarget);
    if (byName.length > 0) {
      return { targets: byName, match: "name" };
    }

    const byIdPrefix = Array.from(this.sessions.values()).filter(session => session.info.id.toLowerCase().startsWith(lowerTarget));
    if (byIdPrefix.length > 0) {
      return { targets: byIdPrefix, match: "idPrefix" };
    }

    return { targets: [], match: "none" };
  }

  private isSocketWritable(socket: net.Socket): boolean {
    return !socket.destroyed && !socket.writableEnded && socket.writable;
  }

  private removeSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionId);
    session.socket.destroy();
    console.log(`Removed intercom session ${sessionId}: ${reason}`);
    this.broadcast({ type: "session_left", sessionId }, sessionId);
    this.scheduleShutdownCheck();
  }

  private broadcast(msg: BrokerMessage, exclude?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude) {
        writeMessage(session.socket, msg);
      }
    }
  }

  private shutdown(): void {
    console.log("Broker shutting down");
    
    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // The socket may already be gone if shutdown started after a disconnect.
      }
    }
    try {
      unlinkSync(PID_PATH);
    } catch {
      // The PID file may already be gone if startup never completed.
    }
    this.server.close();
    process.exit(0);
  }
}

new IntercomBroker().start();
