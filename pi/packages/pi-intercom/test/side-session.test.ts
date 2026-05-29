import { test } from "node:test";
import assert from "node:assert/strict";
import { answerAside, ASIDE_TOOLS, ASIDE_TIMEOUT_MS } from "../side-session.ts";

test("answerAside exposes read-only inspection tools and a default timeout", () => {
  // The aside sub-session must never get mutating tools (bash/edit/write): it
  // answers a question, it doesn't act on the peer's working tree.
  assert.deepEqual([...ASIDE_TOOLS], ["read", "ls", "find", "grep"]);
  assert.ok(ASIDE_TIMEOUT_MS > 0);
});

test("answerAside rejects when the target session has no active model", async () => {
  const ctx = {
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: {},
    getSystemPrompt: () => "",
    sessionManager: { getEntries: () => [], getLeafId: () => null },
  } as unknown as Parameters<typeof answerAside>[0];

  await assert.rejects(() => answerAside(ctx, "anything?"), /no active model/);
});
