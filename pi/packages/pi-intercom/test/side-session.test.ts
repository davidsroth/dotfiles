import assert from "node:assert/strict";
import test from "node:test";
import { answerAside, ASIDE_TOOLS, ASIDE_TIMEOUT_MS } from "../side-session.ts";

test("answerAside exposes read-only inspection tools and a default timeout", () => {
  // The aside sub-session must never get mutating tools (bash/edit/write): it
  // answers out of band while the main session continues owning the workspace.
  assert.deepEqual([...ASIDE_TOOLS], ["read", "ls", "find", "grep"]);
  assert.ok(ASIDE_TIMEOUT_MS > 0);
});

test("answerAside rejects when the target session has no active model", async () => {
  const ctx = {
    model: undefined,
    cwd: process.cwd(),
  } as unknown as Parameters<typeof answerAside>[0];

  await assert.rejects(() => answerAside(ctx, "anything?"), /no active model/);
});
