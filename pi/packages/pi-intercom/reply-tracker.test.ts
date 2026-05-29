import test from "node:test";
import assert from "node:assert/strict";
import { ReplyTracker } from "./reply-tracker.ts";
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
