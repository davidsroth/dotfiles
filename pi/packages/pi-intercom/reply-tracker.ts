import type { Message, SessionInfo } from "./types.ts";

export interface IntercomContext {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
}

/** State of an in-flight outbound `ask`/`aside` awaiting its reply. */
export interface ReplyWaiterMatch {
  /** The question message id; the reply must carry this as `replyTo`. This is the correlation key. */
  questionId: string;
  /** The raw target string passed to `ask` (may be a full id, name, or short/prefix id). */
  expectedSenderTarget: string;
  /** Broker-resolved full id of the recipient, captured from the delivery ack. */
  expectedSenderId?: string;
}

/**
 * Decide whether an inbound message resolves a given outbound ask-waiter.
 *
 * Correlation is the unique `questionId` (the caller normally looks the waiter
 * up by `message.replyTo` directly). The sender comparison here is a defensive
 * ASSERTION, not the correlation key: it rejects a reply that carries a valid
 * questionId but comes from a session other than the one we addressed (a
 * confused or malicious peer). When the broker-resolved `expectedSenderId` is
 * known it is authoritative; otherwise we fall back to a permissive match
 * against the raw target (full id, id prefix, or name) so a valid reply is
 * never dropped over an addressing-format mismatch.
 */
export function replyResolvesWaiter(
  waiter: ReplyWaiterMatch,
  from: Pick<SessionInfo, "id" | "name">,
  message: Pick<Message, "replyTo">,
): boolean {
  if (message.replyTo !== waiter.questionId) {
    return false;
  }
  if (waiter.expectedSenderId !== undefined) {
    return from.id === waiter.expectedSenderId;
  }
  const target = waiter.expectedSenderTarget.toLowerCase();
  return from.id.toLowerCase() === target
    || from.id.toLowerCase().startsWith(target)
    || from.name?.toLowerCase() === target;
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

  resolveReplyTarget(options: { to?: string; replyTo?: string }, now = Date.now()): IntercomContext {
    this.pruneExpired(now);

    // 1. An explicit message id is unambiguous — it selects exactly one ask,
    //    including two asks from the SAME sender (which no sender-based key
    //    can disambiguate). `pending` prints these ids for this purpose.
    if (options.replyTo) {
      const byId = this.pendingAsks.get(options.replyTo);
      if (byId) {
        return byId;
      }
      throw new Error(`No pending ask with id \"${options.replyTo}\"`);
    }

    const pending = Array.from(this.pendingAsks.values());

    // 2. An explicit sender wins over the implicit current-turn context (an
    //    explicit `to` is clear intent; the triggered-message default must not
    //    override it).
    if (options.to) {
      const matches = pending.filter((context) => matchesPendingSender(context, options.to!));
      if (matches.length === 1) {
        return matches[0]!;
      }
      if (matches.length > 1) {
        throw new Error(`Multiple pending asks from \"${options.to}\" — reply with the message id (from \`pending\`) via \`replyTo\`.`);
      }
      // No pending ask matched the sender; fall back to the triggered message
      // only if it is from that same sender ("reply to what triggered me").
      if (this.currentTurnContext && matchesPendingSender(this.currentTurnContext, options.to)) {
        return this.currentTurnContext;
      }
      throw new Error(`No pending ask from \"${options.to}\"`);
    }

    // 3. No explicit target — the triggered message, then the single pending ask.
    if (this.currentTurnContext) {
      return this.currentTurnContext;
    }
    if (pending.length === 1) {
      return pending[0]!;
    }
    if (pending.length === 0) {
      throw new Error("No active intercom context to reply to");
    }
    throw new Error("Multiple pending asks — specify `to` or `replyTo`");
  }

  markReplied(replyTo: string): void {
    this.pendingAsks.delete(replyTo);
    if (this.currentTurnContext?.message.id === replyTo) {
      this.currentTurnContext = null;
    }
  }

  /**
   * Drop all inbound state from a sender that has left. Its pending asks can no
   * longer be usefully replied to (the reply would just fail to deliver), so
   * remove them here rather than let them linger until the 10-minute TTL.
   */
  dropPendingFromSender(sessionId: string): void {
    for (const [messageId, context] of this.pendingAsks) {
      if (context.from.id === sessionId) {
        this.pendingAsks.delete(messageId);
      }
    }
    if (this.currentTurnContext?.from.id === sessionId) {
      this.currentTurnContext = null;
    }
    for (let i = this.pendingTurnContexts.length - 1; i >= 0; i--) {
      if (this.pendingTurnContexts[i]!.from.id === sessionId) {
        this.pendingTurnContexts.splice(i, 1);
      }
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
