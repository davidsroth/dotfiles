import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAttachment,
  isMessage,
  isSessionInfo,
  isSessionRegistration,
} from "../broker/validation.ts";

const validRegistration = {
  cwd: "/tmp/project",
  model: "test-model",
  pid: 1234,
  startedAt: 1,
  lastActivity: 2,
};

test("isAttachment validates type, name, content, optional language", () => {
  assert.equal(isAttachment({ type: "file", name: "a.txt", content: "x" }), true);
  assert.equal(isAttachment({ type: "snippet", name: "s", content: "x", language: "ts" }), true);
  assert.equal(isAttachment({ type: "bogus", name: "a", content: "x" }), false);
  assert.equal(isAttachment({ type: "file", name: "a" }), false);
  assert.equal(isAttachment({ type: "file", name: "a", content: 1 }), false);
  assert.equal(isAttachment({ type: "file", name: "a", content: "x", language: 5 }), false);
  assert.equal(isAttachment(null), false);
});

test("isMessage requires id/timestamp/content.text and validates attachments", () => {
  assert.equal(isMessage({ id: "m1", timestamp: 1, content: { text: "hi" } }), true);
  assert.equal(isMessage({ id: "m1", timestamp: 1, expectsReply: true, replyTo: "q", content: { text: "hi" } }), true);
  assert.equal(
    isMessage({ id: "m1", timestamp: 1, content: { text: "hi", attachments: [{ type: "file", name: "a", content: "x" }] } }),
    true,
  );
  assert.equal(isMessage({ id: "m1", timestamp: 1, content: { text: 5 } }), false);
  assert.equal(isMessage({ id: "m1", content: { text: "hi" } }), false);
  assert.equal(isMessage({ id: "m1", timestamp: 1, expectsReply: "yes", content: { text: "hi" } }), false);
  assert.equal(isMessage({ id: "m1", timestamp: 1, aside: true, expectsReply: true, content: { text: "hi" } }), true);
  assert.equal(isMessage({ id: "m1", timestamp: 1, aside: "yes", content: { text: "hi" } }), false);
  assert.equal(
    isMessage({ id: "m1", timestamp: 1, content: { text: "hi", attachments: [{ type: "bad" }] } }),
    false,
  );
});

test("isSessionInfo requires an id plus the shared fields", () => {
  assert.equal(isSessionInfo({ id: "s1", ...validRegistration }), true);
  assert.equal(isSessionInfo({ id: "s1", ...validRegistration, name: "n", status: "idle", originSessionId: "o" }), true);
  assert.equal(isSessionInfo({ ...validRegistration }), false, "missing id");
  assert.equal(isSessionInfo({ id: 1, ...validRegistration }), false, "non-string id");
  assert.equal(isSessionInfo({ id: "s1", ...validRegistration, pid: "x" }), false);
  assert.equal(isSessionInfo({ id: "s1", ...validRegistration, name: 5 }), false);
});

test("isSessionRegistration accepts the shared fields without an id", () => {
  assert.equal(isSessionRegistration(validRegistration), true);
  assert.equal(isSessionRegistration({ ...validRegistration, originSessionId: "o" }), true);
  assert.equal(isSessionRegistration({ ...validRegistration, lastActivity: "x" }), false);
  assert.equal(isSessionRegistration(null), false);
  assert.equal(isSessionRegistration([validRegistration]), false);
});
