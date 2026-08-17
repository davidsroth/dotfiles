// Additive local mirrors of the pi-intercom v0.9.2 wire shapes plus the
// portable aside-v1 fields. Unknown optional JSON fields are intentionally
// preserved by relay forwarding rather than stripped by schema conversion.

export const ASIDE_FEATURE = "aside-v1";

export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  peerUid?: number;
  trustedLocal?: boolean;
  features?: string[];
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
}

export interface ExtensionCapability {
  namespace: string;
  ownerEligible: boolean;
}

/** Registration inputs exclude fields owned by the broker. */
export type SessionRegistration = Omit<SessionInfo, "id" | "peerUid" | "trustedLocal"> & {
  extensions?: ExtensionCapability[];
};

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export interface IntercomMessage {
  id: string;
  timestamp: number;
  senderSequence?: number;
  brokerReceivedAt?: number;
  brokerDeliveredAt?: number;
  receiverReceivedAt?: number;
  injectedAt?: number;
  supersedes?: string;
  retryOf?: string;
  replyTo?: string;
  expectsReply?: boolean;
  aside?: boolean;
  replyError?: string;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

// Tailnet protocol additions.

export interface TailnetHello {
  type: "tailnet_hello";
  protocolVersion: 1;
  host: string;
  features?: string[];
}

export interface TailnetDM {
  type: "tailnet_dm";
  fromName: string;
  fromHost: string;
  fromSessionId: string;
  toName: string;
  toHost: string;
  toResolver:
    | { kind: "name"; name: string }
    | { kind: "sessionId"; id: string };
  message: IntercomMessage;
}

export interface TailnetDeliveryAck {
  type: "tailnet_delivery_ack";
  messageId: string;
  delivered: boolean;
  reason?: string;
}

export interface TailnetSessionList {
  type: "tailnet_sessions";
  sessions: SessionInfo[];
}

export interface TailnetSessionJoined {
  type: "tailnet_session_joined";
  session: SessionInfo;
}

export interface TailnetSessionLeft {
  type: "tailnet_session_left";
  sessionId: string;
}

export type TailnetFrame =
  | TailnetHello
  | TailnetDM
  | TailnetDeliveryAck
  | TailnetSessionList
  | TailnetSessionJoined
  | TailnetSessionLeft;
