// Local mirrors of the pi-intercom wire shapes. Kept as a separate
// declaration so we don't reach into pi-intercom's `node_modules` from
// the relay daemon (which runs as its own process and may not have
// pi-intercom's deps resolved on every launch).
//
// If these drift from pi-intercom's `types.ts` we'll catch it at
// runtime when JSON deserialisation rejects an unexpected field.

export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export interface IntercomMessage {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

// Tailnet-only protocol additions (§6 of the scope doc).

export interface TailnetHello {
  type: "tailnet_hello";
  protocolVersion: 1;
  host: string;
  features?: string[];
}

export interface TailnetDM {
  type: "tailnet_dm";
  // Both endpoints carry the @host suffix; the receiver strips its own
  // host to find/register the matching local virtual session.
  fromName: string;        // e.g. "planner@nimbus"
  fromHost: string;        // MagicDNS short name of sender's host
  fromSessionId: string;   // sender's local broker session id
  toName: string;          // e.g. "worker@aurora" (display only)
  toHost: string;          // MagicDNS short name (the receiver)
  toResolver:              // how the receiver should find a local target
    | { kind: "name"; name: string }      // bare name (no @host suffix)
    | { kind: "sessionId"; id: string };  // exact session id
  message: IntercomMessage;
}

export interface TailnetDeliveryAck {
  type: "tailnet_delivery_ack";
  messageId: string;
  delivered: boolean;
  // Opaque — see §4.2: collapse `denied` / `not_found` / `pending` here.
  reason?: string;
}

export type TailnetFrame =
  | TailnetHello
  | TailnetDM
  | TailnetDeliveryAck;
