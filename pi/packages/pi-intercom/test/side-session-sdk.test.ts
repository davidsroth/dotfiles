import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { answerAside } from "../side-session.ts";

// Regression: the aside fork used an empty in-memory SessionManager and seeded
// only agent.state.messages. Pi rebuilds each request's context from the
// session manager, so the recipient's history was dropped (observed on the
// request after a read-only tool call) and asides answered with no context.
test("answerAside keeps the recipient's history on every request, including after a tool call", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-intercom-aside-sdk-"));
  try {
    await writeFile(join(cwd, "example.txt"), "Read-only fixture");
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
    } as Parameters<typeof ModelRuntime.create>[0]);
    const faux = fauxProvider({ models: [{ id: "aside-test" }], tokensPerSecond: 100_000 } as Parameters<typeof fauxProvider>[0]);
    runtime.registerNativeProvider(faux.provider);

    const parent = SessionManager.inMemory(cwd);
    parent.appendMessage({ role: "user", content: "Main session sentinel", timestamp: 1 });
    parent.appendMessage(fauxAssistantMessage("Earlier answer"));
    parent.appendMessage({ role: "user", content: "Follow-up context", timestamp: 2 });
    const original = structuredClone(parent.getEntries());

    const assertHistory = (messages: unknown[]) => {
      const head = JSON.stringify(messages.slice(0, 3));
      assert.ok(head.includes("Main session sentinel"), `history missing sentinel: ${head}`);
      assert.ok(head.includes("Earlier answer"), `history missing assistant turn: ${head}`);
      assert.ok(head.includes("Follow-up context"), `history missing follow-up: ${head}`);
    };

    let requests = 0;
    faux.setResponses([
      (context) => {
        requests++;
        assertHistory(context.messages);
        return fauxAssistantMessage(fauxToolCall("read", { path: "example.txt" }), { stopReason: "toolUse" });
      },
      (context) => {
        requests++;
        assertHistory(context.messages);
        const toolResult = context.messages.find((message) => message.role === "toolResult");
        assert.ok(JSON.stringify(toolResult).includes("Read-only fixture"));
        return fauxAssistantMessage("The fixture says: Read-only fixture.");
      },
    ]);

    const ctx = {
      cwd,
      model: faux.getModel(),
      modelRegistry: new ModelRegistry(runtime),
      sessionManager: parent,
      getSystemPrompt: () => "Main system instructions",
    } as unknown as ExtensionContext;

    const answer = await answerAside(ctx, "Read example.txt", { timeoutMs: 10_000 });
    assert.equal(answer, "The fixture says: Read-only fixture.");
    assert.equal(requests, 2);
    // The recipient session and workspace are untouched.
    assert.deepEqual(parent.getEntries(), original);
    assert.equal(await readFile(join(cwd, "example.txt"), "utf8"), "Read-only fixture");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
