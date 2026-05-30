import type { Message, SessionInfo } from "./types.ts";

export interface IntercomContext {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
}

/** State of an in-flight outbound `ask`/`aside` awaiting its reply. */
export interface ReplyWaiterMatch {
  /** The raw target string passed to `ask` (may be a full id, name, or short/prefix id). */
  from: string;
  /** The id of the question message; the reply must carry this as `replyTo`. */
  replyTo: string;
  /** Broker-resolved full id of the recipient, captured from the delivery ack. */
  recipientId?: string;
}

/**
 * Decide whether an inbound message resolves a pending outbound ask-waiter.
 *
 * The sender match must tolerate prefix/short-id addressing: when `ask` was
 * addressed by a short id (as `intercom list` prints) or a name, the reply's
 * `from.id` is the full session id and won't equal the raw `waiter.from`. The
 * broker-resolved `recipientId` bridges that gap. Without it, prefix-addressed
 * replies fall through to the idle-message buffer and only surface when the
 * turn ends (e.g. on cancel) — the ask never resolves on its own.
 */
export function replyResolvesWaiter(
  waiter: ReplyWaiterMatch,
  from: Pick<SessionInfo, "id" | "name">,
  message: Pick<Message, "replyTo">,
): boolean {
  const senderTarget = from.name || from.id;
  const fromMatches = senderTarget.toLowerCase() === waiter.from.toLowerCase()
    || from.id === waiter.from
    || (waiter.recipientId !== undefined && from.id === waiter.recipientId);
  const replyMatches = message.replyTo === waiter.replyTo;
  return fromMatches && replyMatches;
}

function matchesPendingSender(context: IntercomContext, to: string): boolean {
  if (context.from.id === to) {
    return true;
  }

  return context.from.name?.toLowerCase() === to.toLowerCase();
}

export class ReplyTracker {
  private readonly pendingAsks = new Map<string, IntercomContext>();
  private readonly pendingTurnContexts: IntercomContext[] = [];
  private currentTurnContext: IntercomContext | null = null;

  constructor(
    private readonly askTimeoutMs = 10 * 60 * 1000,
    // Bound the queue of turn contexts so a long non-idle stretch with steady
    // inbound messages can't grow it without limit (only beginTurn drains it,
    // one per turn). Oldest entries are dropped first.
    private readonly maxPendingTurnContexts = 200,
  ) {}

  recordIncomingMessage(from: SessionInfo, message: Message, receivedAt = Date.now()): IntercomContext {
    const context = { from, message, receivedAt };
    if (message.expectsReply) {
      this.pendingAsks.set(message.id, context);
    }
    return context;
  }

  queueTurnContext(context: IntercomContext): void {
    this.pendingTurnContexts.push(context);
    while (this.pendingTurnContexts.length > this.maxPendingTurnContexts) {
      this.pendingTurnContexts.shift();
    }
  }

  beginTurn(now = Date.now()): void {
    this.pruneExpired(now);
    this.currentTurnContext = this.pendingTurnContexts.shift() ?? null;
  }

  endTurn(): void {
    this.currentTurnContext = null;
  }

  reset(): void {
    this.pendingAsks.clear();
    this.pendingTurnContexts.length = 0;
    this.currentTurnContext = null;
  }

  resolveReplyTarget(options: { to?: string }, now = Date.now()): IntercomContext {
    this.pruneExpired(now);

    if (this.currentTurnContext) {
      return this.currentTurnContext;
    }

    const pending = Array.from(this.pendingAsks.values());
    if (pending.length === 1) {
      return pending[0]!;
    }

    if (options.to) {
      const matches = pending.filter((context) => matchesPendingSender(context, options.to!));
      if (matches.length === 1) {
        return matches[0]!;
      }
      if (matches.length > 1) {
        throw new Error(`Multiple pending asks from \"${options.to}\" — use the sender session ID instead.`);
      }
      if (pending.length > 1) {
        throw new Error(`No pending ask from \"${options.to}\"`);
      }
    }

    if (pending.length === 0) {
      throw new Error("No active intercom context to reply to");
    }

    throw new Error("Multiple pending asks — specify `to`");
  }

  markReplied(replyTo: string): void {
    this.pendingAsks.delete(replyTo);
    if (this.currentTurnContext?.message.id === replyTo) {
      this.currentTurnContext = null;
    }
  }

  listPending(now = Date.now()): IntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private pruneExpired(now: number): void {
    for (const [messageId, context] of this.pendingAsks) {
      if (now - context.receivedAt > this.askTimeoutMs) {
        this.pendingAsks.delete(messageId);
      }
    }
    // Turn contexts are FIFO by receivedAt, so stale entries form a prefix.
    const cutoff = now - this.askTimeoutMs;
    let expired = 0;
    while (
      expired < this.pendingTurnContexts.length
      && this.pendingTurnContexts[expired]!.receivedAt <= cutoff
    ) {
      expired += 1;
    }
    if (expired > 0) {
      this.pendingTurnContexts.splice(0, expired);
    }
  }
}
