import test from "node:test";
import assert from "node:assert/strict";
import { IntercomClient } from "./client.ts";

test("validated session lifecycle messages reach broker-message subscribers", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  const received: unknown[] = [];
  client.onBrokerMessage((message) => received.push(message));
  const session = {
    id: "session-2",
    cwd: "/test",
    model: "test",
    pid: 2,
    startedAt: 1,
    lastActivity: 1,
  };

  (client as any).handleBrokerMessage({ type: "session_joined", session });
  (client as any).handleBrokerMessage({ type: "presence_update", session });
  (client as any).handleBrokerMessage({ type: "session_left", sessionId: "session-2" });

  assert.deepEqual(received, [
    { type: "session_joined", session },
    { type: "presence_update", session },
    { type: "session_left", sessionId: "session-2" },
  ]);
});

test("registered feature negotiation rejects non-string feature entries", () => {
  const client = new IntercomClient();
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "registered", sessionId: "session-1", features: ["valid", 123] }),
    /Invalid registered features/,
  );
});

test("malformed extension broker messages are rejected", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";

  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_owner", namespace: "test/v1", ownerId: "owner" }),
    /Invalid extension_owner/,
  );
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_owner", namespace: "test/v1", ownerEpoch: "epoch" }),
    /Invalid extension_owner/,
  );
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_message", namespace: "test/v1" }),
    /Invalid extension_message/,
  );
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_state", namespace: "test/v1", revision: -1 }),
    /Invalid extension_state/,
  );
  assert.throws(
    () => (client as any).handleBrokerMessage({ type: "extension_state_result", namespace: "test/v1", committed: "yes", revision: 1 }),
    /Invalid extension_state_result/,
  );
  assert.doesNotThrow(() => (client as any).handleBrokerMessage({
    type: "extension_message",
    namespace: "test/v1",
    fromSessionId: "session-2",
    payload: { peerOnly: true },
  }));
});

test("aside and replyError flags survive client message validation", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  const from = {
    id: "sender",
    cwd: "/test",
    model: "test",
    pid: 2,
    startedAt: 1,
    lastActivity: 1,
  };
  const received: unknown[] = [];
  client.on("message", (_from, message) => received.push(message));

  (client as any).handleBrokerMessage({
    type: "message",
    from,
    message: {
      id: "aside-1",
      timestamp: 1,
      aside: true,
      expectsReply: true,
      content: { text: "question" },
    },
  });
  (client as any).handleBrokerMessage({
    type: "message",
    from,
    message: {
      id: "reply-1",
      timestamp: 2,
      replyTo: "aside-1",
      replyError: "failed",
      content: { text: "failed" },
    },
  });

  assert.equal((received[0] as { aside?: boolean }).aside, true);
  assert.equal((received[1] as { replyError?: string }).replyError, "failed");
});

test("send rejects a duplicate pending message ID without replacing the first waiter", async () => {
  const client = new IntercomClient();
  const writes: Buffer[] = [];
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write(chunk: Buffer) {
      writes.push(chunk);
      return true;
    },
  };

  const first = client.send("session-2", { messageId: "duplicate-id", text: "first" });
  await assert.rejects(
    client.send("session-2", { messageId: "duplicate-id", text: "second" }),
    /already pending/,
  );
  assert.equal(writes.length, 1);

  (client as any).handleBrokerMessage({ type: "delivered", messageId: "duplicate-id" });
  assert.deepEqual(await first, { id: "duplicate-id", delivered: true });
});

test("cancelAsk ignores synchronous socket write failures", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {
      throw new Error("write failed");
    },
  };

  assert.doesNotThrow(() => client.cancelAsk("ask-1"));
});
