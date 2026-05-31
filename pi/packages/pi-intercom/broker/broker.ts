import net from "net";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { writeMessage, writeFrame, encodeMessage, createMessageReader, MAX_FRAME_BYTES } from "./framing.js";
import { getBrokerSocketPath } from "./paths.js";
import { isMessage, isSessionRegistration } from "./validation.js";
import type { SessionInfo, BrokerMessage } from "../types.js";
import { PROTOCOL_VERSION } from "../types.js";

const INTERCOM_DIR = join(homedir(), ".pi/agent/intercom");
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");
// If a peer's outbound buffer grows past this, the consumer isn't reading (a
// wedged or SIGKILL'd-but-not-closed socket). Node would otherwise buffer the
// data in broker memory without bound; treat such a peer as dead and reap it.
// Override with PI_INTERCOM_MAX_SOCKET_BUFFER_BYTES.
//
// The cap is floored at 2x the max frame size: a single legal message can be
// up to MAX_FRAME_BYTES, and the re-framed forward adds the sender's
// SessionInfo, so one in-flight message to a momentarily-slow (but healthy)
// consumer must NOT be mistaken for a wedge and reaped mid-delivery. Headroom
// for one in-flight + one queued max frame is the smallest safe bound.
const MAX_SOCKET_BUFFER_FLOOR = MAX_FRAME_BYTES * 2;
const MAX_SOCKET_BUFFER_BYTES: number = (() => {
  const raw = Number(process.env.PI_INTERCOM_MAX_SOCKET_BUFFER_BYTES);
  const configured = Number.isInteger(raw) && raw > 0 ? raw : 8 * 1024 * 1024;
  return Math.max(configured, MAX_SOCKET_BUFFER_FLOOR);
})();
// Period for the liveness sweep that reaps sessions whose owning process is
// gone. A SIGKILL'd peer's socket `close` may never fire (e.g. its FD was
// inherited by an ancestor terminal), so event-driven teardown alone leaves
// zombies. Override with PI_INTERCOM_REAPER_INTERVAL_MS; 0 disables the sweep.
const REAPER_INTERVAL_MS: number = (() => {
  const raw = Number(process.env.PI_INTERCOM_REAPER_INTERVAL_MS);
  return Number.isInteger(raw) && raw >= 0 ? raw : 30_000;
})();

/**
 * Whether a pid is definitively gone. Returns true only on ESRCH (no such
 * process); EPERM (exists, not ours), invalid pids, and live processes all
 * return false so we never reap a session we can't prove is dead.
 */
function isProcessLikelyDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
}

interface SessionLookup {
  targets: ConnectedSession[];
  match: "id" | "name" | "idPrefix" | "none";
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private reapTimer: NodeJS.Timeout | null = null;

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
    // Without an 'error' listener, a listen failure (EADDRINUSE race, EACCES,
    // permissions on the socket dir) is thrown as an uncaught exception and the
    // broker dies silently. Surface it deterministically and exit non-zero so
    // the spawning client reports a real startup failure.
    this.server.on("error", (error) => {
      console.error("Intercom broker server error:", error);
      process.exit(1);
    });
    // Defense-in-depth: the shared broker serves every session, so one stray
    // throw/rejection outside the per-connection framing guard must not take
    // the whole mesh down. Log and keep serving.
    process.on("uncaughtException", (error) => {
      console.error("Intercom broker uncaught exception:", error);
    });
    process.on("unhandledRejection", (reason) => {
      console.error("Intercom broker unhandled rejection:", reason);
    });
    this.server.listen(SOCKET_PATH, () => {
      writeFileSync(PID_PATH, String(process.pid));
      console.log(`Intercom broker started (pid: ${process.pid})`);
    });
    if (REAPER_INTERVAL_MS > 0) {
      this.reapTimer = setInterval(() => this.reapDeadSessions(), REAPER_INTERVAL_MS);
      // Don't keep the process alive solely for the sweep.
      this.reapTimer.unref();
    }
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private reapDeadSessions(): void {
    const dead: Array<{ id: string; pid: number }> = [];
    for (const [id, session] of this.sessions) {
      if (isProcessLikelyDead(session.info.pid)) {
        dead.push({ id, pid: session.info.pid });
      }
    }
    for (const { id, pid } of dead) {
      this.removeSession(id, `Owning process ${pid} no longer running`);
    }
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

        writeMessage(socket, { type: "registered", sessionId: id, version: PROTOCOL_VERSION });
        this.broadcast({ type: "session_joined", session: info }, id);
        break;
      }

      case "unregister": {
        this.sessions.delete(currentId);
        setId(null);
        this.broadcast({ type: "session_left", sessionId: currentId }, currentId);
        // The client always `socket.end()`s right after sending `unregister`
        // and never reuses this socket, so destroy it now to release the FD
        // immediately instead of waiting for the end/close roundtrip.
        socket.destroy();
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
          if (target.info.id === currentId) {
            // Authoritative self-send guard: clients no longer pre-resolve the
            // target, so the broker rejects messages a session addresses to
            // itself (by id, name, or id prefix) here.
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Cannot message the current session",
            });
            break;
          }
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
          if (this.isSocketBackedUp(target.socket)) {
            this.removeSession(target.info.id, "Backpressure: outbound buffer exceeded");
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Recipient is not reading messages",
            });
            break;
          }
          // Encode the forward frame BEFORE writing. The forward adds the
          // sender's SessionInfo, so a message at/near the cap inbound can
          // exceed MAX_FRAME_BYTES once re-framed and make encodeMessage throw.
          // That is the SENDER's fault (oversized payload) — it must not be
          // mistaken for the recipient's socket dying and evict an innocent,
          // healthy session.
          let forwardFrame: Buffer;
          try {
            forwardFrame = encodeMessage({
              type: "message",
              from: fromSession.info,
              message,
            });
          } catch {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Message too large",
            });
            break;
          }
          try {
            writeFrame(target.socket, forwardFrame);
          } catch {
            this.removeSession(target.info.id, "Session disconnected");
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Session disconnected",
            });
            break;
          }
          writeMessage(socket, { type: "delivered", messageId: message.id, recipientId: target.info.id });
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
        // Forward compatibility: a newer client may send a request type this
        // (older, long-lived) broker doesn't know. Ignore it rather than
        // throwing — throwing reaches the reader's onError and destroys the
        // socket, disconnecting a newer client the moment it uses a new request
        // type. The newer client's request simply goes unanswered (and times
        // out client-side) instead of taking down the whole connection.
        // Known-but-malformed messages are still rejected in their own cases,
        // and a pre-registration unknown type is still rejected above.
        console.log(`Ignoring unknown client message type: ${clientMessage.type}`);
        break;
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

  /**
   * True when a peer's outbound buffer has grown past the high-water mark,
   * indicating the consumer isn't draining it (slow, wedged, or half-open).
   * Such a peer must be reaped rather than written to, to bound broker memory.
   */
  private isSocketBackedUp(socket: net.Socket): boolean {
    return socket.writableLength > MAX_SOCKET_BUFFER_BYTES;
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
    // Serialize once and reuse the frame for every recipient instead of
    // re-stringifying + re-encoding per peer (the dominant broadcast cost,
    // O(N) JSON.stringify otherwise).
    let frame: Buffer;
    try {
      frame = encodeMessage(msg);
    } catch (error) {
      console.error("Failed to encode broadcast message:", error);
      return;
    }
    // A write can throw synchronously (e.g. ERR_STREAM_WRITE_AFTER_END on a
    // half-closed socket). Isolate each write so one dead peer can't abort the
    // loop and starve the remaining sessions of the broadcast. Reap the dead
    // entry after the loop; removeSession re-broadcasts session_left, but its
    // own guard (missing entry => no-op) bounds the recursion.
    const dead: string[] = [];
    for (const [id, session] of this.sessions) {
      if (id === exclude) continue;
      // Don't pile more onto a peer that isn't draining; reap it instead.
      if (this.isSocketBackedUp(session.socket)) {
        dead.push(id);
        continue;
      }
      try {
        writeFrame(session.socket, frame);
      } catch {
        dead.push(id);
      }
    }
    for (const id of dead) {
      this.removeSession(id, "Broadcast write failed or backpressured peer");
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
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    this.server.close();
    process.exit(0);
  }
}

new IntercomBroker().start();
