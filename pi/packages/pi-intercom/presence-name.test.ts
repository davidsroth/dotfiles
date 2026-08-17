import test from "node:test";
import assert from "node:assert/strict";
import { resolveIntercomPresenceName } from "./presence-name.ts";

test("uses a trimmed explicit name", () => {
  assert.equal(resolveIntercomPresenceName("  worker  ", "019abc"), "worker");
});

test("uses the random ID tail for unnamed sessions", () => {
  const id = "01HVABCDEFGHJKMNPQRSTVWXYZ";
  assert.equal(resolveIntercomPresenceName(undefined, id), "subagent-chat-RSTVWXYZ");
  assert.equal(resolveIntercomPresenceName(undefined, `session-${id}`), "subagent-chat-RSTVWXYZ");
});

test("parallel time-ordered IDs produce distinct aliases", () => {
  const prefix = "01HVABCDEF";
  assert.notEqual(
    resolveIntercomPresenceName(undefined, `${prefix}AAAAAAAAAAAAAAAA`),
    resolveIntercomPresenceName(undefined, `${prefix}BBBBBBBBBBBBBBBB`),
  );
});

test("short IDs degrade gracefully", () => {
  assert.equal(resolveIntercomPresenceName("  ", "abcd"), "subagent-chat-abcd");
});
