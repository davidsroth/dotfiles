/**
 * Wire protocol version. The broker is a long-lived daemon shared across
 * sessions and survives in-place package upgrades, so a newer session can talk
 * to an older broker (or vice-versa). Bump this when adding/changing message
 * shapes. The handshake is forward/backward compatible: the field rides on
 * `register`/`registered` as an optional sibling (old peers omit it, new peers
 * tolerate its absence), and unknown message *types* are ignored rather than
 * fatal (see the client/broker message dispatch defaults), so a newer peer can
 * introduce a new event type without disconnecting older peers.
 */
export const PROTOCOL_VERSION = 1;

export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  /**
   * Stable per-session identity (the pi session id) that survives broker
   * reconnects. The broker uses this to evict a prior registration from the
   * same session when it reconnects with a fresh UUID, so duplicate rows do
   * not accumulate when the old socket's `close` never fires. Optional for
   * backward compatibility with clients that predate this field.
   */
  originSessionId?: string;
}

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  /**
   * Marks this as a one-off "aside" question: the recipient answers it out of
   * band using an in-memory forked sub-session seeded with its current
   * context, instead of injecting it into the timeline / triggering a turn.
   * The recipient's persisted history is never touched and its current work is
   * not interrupted. The answer comes back through the normal reply path
   * (`replyTo` = this message id). Optional and forward-compatible: peers that
   * predate this field simply treat the message as a normal send.
   */
  aside?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export type ClientMessage =
  | { type: "register"; session: Omit<SessionInfo, "id">; version?: number }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message }
  | { type: "presence"; name?: string; status?: string; model?: string };

export type BrokerMessage =
  | { type: "registered"; sessionId: string; version?: number }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string; recipientId?: string }
  | { type: "delivery_failed"; messageId: string; reason: string };
