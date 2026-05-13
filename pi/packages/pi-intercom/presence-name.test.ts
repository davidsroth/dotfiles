import test from "node:test";
import assert from "node:assert/strict";
import { resolveIntercomPresenceName } from "./presence-name.ts";

// These tests guard the alias-derivation rules used to advertise this session
// to the broker when the user hasn't given the session an explicit name.
//
// Regression context: pi session IDs are ULIDs whose first ~10 characters
// encode the millisecond timestamp. An earlier implementation derived the
// alias from `id.slice(0, 8)`, which collides at ~256 ms granularity — every
// time pi launched a batch of sub-agents in parallel, two of them ended up
// with the same `subagent-chat-<prefix>` alias on the broker. The fix is to
// slice the trailing chars instead, which carry the ULID's random tail.

test("returns the trimmed user-supplied name when one is set", () => {
  assert.equal(
    resolveIntercomPresenceName("  Refactor auth module  ", "01HVABCDEFGHJKMNPQRSTVWXYZ"),
    "Refactor auth module",
  );
});

test("falls back to subagent-chat-<tail8> when no name is set", () => {
  // 26-char ULID; `.slice(-8)` keeps the last 8 chars (random tail).
  const id = "01HVABCDEFGHJKMNPQRSTVWXYZ";
  assert.equal(resolveIntercomPresenceName(undefined, id), `subagent-chat-${id.slice(-8)}`);
  assert.equal(resolveIntercomPresenceName(undefined, id), "subagent-chat-RSTVWXYZ");
});

test("strips a leading 'session-' prefix before slicing", () => {
  const id = "01HVABCDEFGHJKMNPQRSTVWXYZ";
  assert.equal(
    resolveIntercomPresenceName(undefined, `session-${id}`),
    `subagent-chat-${id.slice(-8)}`,
  );
});

test("treats whitespace-only names as empty (uses fallback)", () => {
  const id = "01HVABCDEFGHJKMNPQRSTVWXYZ";
  assert.equal(
    resolveIntercomPresenceName("   \t  ", id),
    `subagent-chat-${id.slice(-8)}`,
  );
});

test("two ULIDs sharing the timestamp prefix produce distinct aliases (regression)", () => {
  // Both IDs share the leading 10 chars (same ms timestamp) but differ in the
  // random tail — exactly the shape of two sub-agents started in parallel.
  const idA = "01HVABCDEF" + "AAAAAAAAAAAAAAAA"; // 26 chars
  const idB = "01HVABCDEF" + "BBBBBBBBBBBBBBBB"; // 26 chars

  const aliasA = resolveIntercomPresenceName(undefined, idA);
  const aliasB = resolveIntercomPresenceName(undefined, idB);

  assert.notEqual(aliasA, aliasB, "aliases must differ for distinct ULIDs with same timestamp");
  assert.equal(aliasA, "subagent-chat-AAAAAAAA");
  assert.equal(aliasB, "subagent-chat-BBBBBBBB");
});

test("very short IDs degrade gracefully (no out-of-range slicing)", () => {
  // `.slice(-8)` on a 4-char string returns the whole string — no padding,
  // no exceptions. Aliases stay deterministic for unusual ID shapes.
  assert.equal(resolveIntercomPresenceName(undefined, "abcd"), "subagent-chat-abcd");
});
