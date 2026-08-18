import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ASIDE_TIMEOUT_MS, getAsideTimeoutMs } from "../config.ts";
import { answerAside, ASIDE_TOOLS } from "../side-session.ts";

test("answerAside exposes read-only inspection tools and a five-minute default timeout", () => {
  // The aside sub-session must never get mutating tools (bash/edit/write): it
  // answers out of band while the main session continues owning the workspace.
  assert.deepEqual([...ASIDE_TOOLS], ["read", "ls", "find", "grep"]);
  assert.equal(DEFAULT_ASIDE_TIMEOUT_MS, 5 * 60 * 1000);
});

test("aside timeout can be configured from environment", () => {
  const previous = process.env.PI_INTERCOM_ASIDE_TIMEOUT_MS;
  delete process.env.PI_INTERCOM_ASIDE_TIMEOUT_MS;
  try {
    assert.equal(getAsideTimeoutMs(), DEFAULT_ASIDE_TIMEOUT_MS);
    process.env.PI_INTERCOM_ASIDE_TIMEOUT_MS = "420000";
    assert.equal(getAsideTimeoutMs(), 420_000);
    assert.throws(() => {
      process.env.PI_INTERCOM_ASIDE_TIMEOUT_MS = "0";
      getAsideTimeoutMs();
    }, /PI_INTERCOM_ASIDE_TIMEOUT_MS must be a positive integer/);
  } finally {
    if (previous === undefined) delete process.env.PI_INTERCOM_ASIDE_TIMEOUT_MS;
    else process.env.PI_INTERCOM_ASIDE_TIMEOUT_MS = previous;
  }
});

test("answerAside rejects when the target session has no active model", async () => {
  const ctx = {
    model: undefined,
    cwd: process.cwd(),
  } as unknown as Parameters<typeof answerAside>[0];

  await assert.rejects(() => answerAside(ctx, "anything?"), /no active model/);
});
