import test from "node:test";
import assert from "node:assert/strict";
import { ReplyTracker, replyResolvesWaiter } from "./reply-tracker.ts";
import type { Message, SessionInfo } from "./types.ts";

function createSession(id: string, name: string): SessionInfo {
  return {
    id,
    name,
    cwd: "/tmp/project",
    model: "test-model",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
  };
}

function createMessage(id: string, text: string, expectsReply = true): Message {
  return {
    id,
    timestamp: 1,
    expectsReply,
    content: { text },
  };
}

test("reply resolves from current triggered message context", () => {
  const tracker = new ReplyTracker();
  const from = createSession("planner-id", "planner");
  const message = createMessage("ask-1", "Need a decision");

  const context = tracker.recordIncomingMessage(from, message, 1000);
  tracker.queueTurnContext(context);
  tracker.beginTurn(1001);

  assert.equal(tracker.resolveReplyTarget({}, 1002).message.id, "ask-1");
  assert.equal(tracker.resolveReplyTarget({}, 1002).from.id, "planner-id");
});

test("reply resolves from single pending ask without current turn context", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  assert.equal(tracker.resolveReplyTarget({}, 1001).message.id, "ask-1");
});

test("reply with to resolves matching pending ask", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);

  assert.equal(tracker.resolveReplyTarget({ to: "reviewer" }, 1002).message.id, "ask-2");
  assert.equal(tracker.resolveReplyTarget({ to: "planner-id" }, 1002).message.id, "ask-1");
});

test("reply with replyTo disambiguates two pending asks from the SAME sender", () => {
  const tracker = new ReplyTracker();
  const planner = createSession("planner-id", "planner");
  tracker.recordIncomingMessage(planner, createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(planner, createMessage("ask-2", "Second"), 1001);

  // Neither name nor id can pick between them; the message id can.
  assert.equal(tracker.resolveReplyTarget({ replyTo: "ask-2" }, 1002).message.id, "ask-2");
  assert.equal(tracker.resolveReplyTarget({ replyTo: "ask-1" }, 1002).message.id, "ask-1");
  // The sender-based path stays ambiguous and points the user at replyTo.
  assert.throws(() => tracker.resolveReplyTarget({ to: "planner" }, 1002), /reply with the message id/);
});

test("reply with an unknown replyTo errors clearly", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  assert.throws(() => tracker.resolveReplyTarget({ replyTo: "nope" }, 1001), /No pending ask with id "nope"/);
});

test("explicit to wins over the current turn context", () => {
  const tracker = new ReplyTracker();
  const planner = createSession("planner-id", "planner");
  const reviewer = createSession("reviewer-id", "reviewer");
  // planner's ask triggers the current turn; reviewer's ask is also pending.
  const triggered = tracker.recordIncomingMessage(planner, createMessage("ask-1", "From planner"), 1000);
  tracker.queueTurnContext(triggered);
  tracker.recordIncomingMessage(reviewer, createMessage("ask-2", "From reviewer"), 1001);
  tracker.beginTurn(1002);

  // No target -> the triggering message (planner).
  assert.equal(tracker.resolveReplyTarget({}, 1003).message.id, "ask-1");
  // Explicit to:reviewer -> reviewer, NOT the triggering planner message.
  assert.equal(tracker.resolveReplyTarget({ to: "reviewer" }, 1003).message.id, "ask-2");
});

test("dropPendingFromSender clears a departed sender's asks and turn context", () => {
  const tracker = new ReplyTracker();
  const planner = createSession("planner-id", "planner");
  const ctx = tracker.recordIncomingMessage(planner, createMessage("ask-1", "First"), 1000);
  tracker.queueTurnContext(ctx);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);
  tracker.beginTurn(1002);

  tracker.dropPendingFromSender("planner-id");

  // planner's ask is gone; only reviewer's remains, and it resolves cleanly.
  assert.deepEqual(tracker.listPending(1003).map((c) => c.message.id), ["ask-2"]);
  assert.equal(tracker.resolveReplyTarget({}, 1003).message.id, "ask-2");
});

test("reply errors when no context and no pending asks", () => {
  const tracker = new ReplyTracker();

  assert.throws(() => tracker.resolveReplyTarget({}, 1000), /No active intercom context to reply to/);
});

test("reply errors when multiple pending asks and no to", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);

  assert.throws(() => tracker.resolveReplyTarget({}, 1002), /Multiple pending asks — specify `to`/);
});

test("reply removes pending ask after successful reply", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  tracker.markReplied("ask-1");

  assert.deepEqual(tracker.listPending(1001), []);
});

test("queueTurnContext drops oldest entries past the cap", () => {
  const cap = 3;
  const tracker = new ReplyTracker(10 * 60 * 1000, cap);
  for (let i = 0; i < cap + 2; i += 1) {
    const ctx = tracker.recordIncomingMessage(
      createSession(`s-${i}`, `s-${i}`),
      createMessage(`ask-${i}`, `m-${i}`, false),
      1000 + i,
    );
    tracker.queueTurnContext(ctx);
  }
  // Only the most recent `cap` survive; the two oldest were dropped.
  tracker.beginTurn(2000);
  // First surviving turn context should be the 3rd queued (index 2), not index 0.
  assert.equal((tracker as unknown as { currentTurnContext: { message: Message } }).currentTurnContext.message.id, "ask-2");
});

test("pruneExpired drops stale queued turn contexts by age", () => {
  const askTimeoutMs = 1000;
  const tracker = new ReplyTracker(askTimeoutMs);
  const stale = tracker.recordIncomingMessage(createSession("old", "old"), createMessage("ask-old", "old", false), 1000);
  const fresh = tracker.recordIncomingMessage(createSession("new", "new"), createMessage("ask-new", "new", false), 5000);
  tracker.queueTurnContext(stale);
  tracker.queueTurnContext(fresh);

  // now=5500: stale (1000) is older than the 1000ms TTL; fresh (5000) survives.
  tracker.beginTurn(5500);
  assert.equal((tracker as unknown as { currentTurnContext: { message: Message } }).currentTurnContext.message.id, "ask-new");
});

test("replyResolvesWaiter correlates by questionId and asserts the sender", () => {
  const fullId = "2f123799-1a97-4f4f-b1fe-34bb5eeed9aa";
  // Broker-resolved id is authoritative: a short/prefix-addressed ask still
  // correlates because the reply's full from.id matches expectedSenderId.
  const waiter = { questionId: "q1", expectedSenderTarget: "2f123799", expectedSenderId: fullId };
  assert.equal(replyResolvesWaiter(waiter, { id: fullId, name: "survey" }, { replyTo: "q1" }), true);
});

test("replyResolvesWaiter falls back to permissive target match without a resolved id", () => {
  const fullId = "2f123799-1a97-4f4f-b1fe-34bb5eeed9aa";
  // No expectedSenderId yet: match the raw target by full id, id prefix, or name.
  assert.equal(
    replyResolvesWaiter({ questionId: "q1", expectedSenderTarget: "2f123799" }, { id: fullId, name: "X" }, { replyTo: "q1" }),
    true,
    "id prefix",
  );
  assert.equal(
    replyResolvesWaiter({ questionId: "q1", expectedSenderTarget: fullId }, { id: fullId, name: "X" }, { replyTo: "q1" }),
    true,
    "full id",
  );
  assert.equal(
    replyResolvesWaiter({ questionId: "q1", expectedSenderTarget: "My Session" }, { id: fullId, name: "My Session" }, { replyTo: "q1" }),
    true,
    "name",
  );
});

test("replyResolvesWaiter requires the reply's replyTo to match the questionId", () => {
  const fullId = "2f123799-1a97-4f4f-b1fe-34bb5eeed9aa";
  const waiter = { questionId: "q1", expectedSenderTarget: "2f123799", expectedSenderId: fullId };
  // Right sender, wrong correlation id -> not this waiter's reply.
  assert.equal(replyResolvesWaiter(waiter, { id: fullId, name: "X" }, { replyTo: "q2" }), false);
});

test("replyResolvesWaiter rejects a valid questionId from the wrong sender (security assertion)", () => {
  // A peer that is NOT the addressee replies with a stolen/guessed questionId:
  // expectedSenderId is authoritative, so the reply must not resolve the wait.
  const waiter = { questionId: "q1", expectedSenderTarget: "planner", expectedSenderId: "2f123799-aaaa" };
  const impostor = { id: "9999bbbb-cccc", name: "someone else" };
  assert.equal(replyResolvesWaiter(waiter, impostor, { replyTo: "q1" }), false);
});
