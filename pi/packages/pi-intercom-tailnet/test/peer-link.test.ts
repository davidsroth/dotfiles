import assert from "node:assert/strict";
import { test } from "node:test";
import { isTailnetDM } from "../relay/peer-link.ts";

test("peer link rejects malformed tailnet_dm before relay dispatch", () => {
  const malformed = {
    type: "tailnet_dm",
    fromName: "sender",
    fromHost: "remote",
    fromSessionId: "sender-id",
    toName: "recipient",
    toHost: "local",
    toResolver: null,
    message: { id: "message-id", timestamp: Date.now(), content: { text: "hello" } },
  };

  assert.equal(isTailnetDM(malformed), false);
});

test("peer link accepts a complete direct-message frame", () => {
  const valid = {
    type: "tailnet_dm",
    fromName: "sender",
    fromHost: "remote",
    fromSessionId: "sender-id",
    toName: "recipient",
    toHost: "local",
    toResolver: { kind: "name", name: "recipient" },
    message: {
      id: "message-id",
      timestamp: Date.now(),
      content: { text: "hello" },
      expectsReply: true,
      aside: true,
    },
  };

  assert.equal(isTailnetDM(valid), true);
});
