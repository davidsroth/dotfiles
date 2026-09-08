import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall,
  InMemoryCredentialStore, InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { answerAside } from "../src/side-session";

it("runs a real SDK fork with a real read tool and a scripted provider, leaving parent and disk untouched", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-aside-sdk-"));
  try {
    await writeFile(join(cwd, "example.txt"), "Read-only fixture");
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
      modelsPath: null, refreshOnCreate: false,
    });
    const faux = fauxProvider({ models: [{ id: "aside-test", reasoning: true }], tokensPerSecond: 100_000 });
    runtime.registerNativeProvider(faux.provider);
    const parent = SessionManager.inMemory(cwd);
    parent.appendMessage({ role: "user", content: "Main session sentinel", timestamp: 1 });
    const original = structuredClone(parent.getEntries());
    let requests = 0;
    faux.setResponses([
      (context, options) => {
        requests++;
        expect(context.tools?.map((tool) => tool.name).sort()).toEqual(["find", "grep", "ls", "read"]);
        expect(context.messages[0]).toMatchObject({ role: "user", content: "Main session sentinel" });
        expect(context.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "Read example.txt" }] });
        expect(context.systemPrompt).toContain("one-off side question");
        expect(options?.reasoning).toBe("high");
        return fauxAssistantMessage(fauxToolCall("read", { path: "example.txt" }), { stopReason: "toolUse" });
      },
      (context) => {
        requests++;
        const toolResult = context.messages.find((message) => message.role === "toolResult");
        expect(JSON.stringify(toolResult)).toContain("Read-only fixture");
        return fauxAssistantMessage("The fixture says: Read-only fixture.");
      },
    ]);
    const ctx = {
      cwd, model: faux.getModel(), thinkingLevel: "high", modelRegistry: new ModelRegistry(runtime),
      sessionManager: parent, getSystemPrompt: () => "Main system instructions",
    } as unknown as ExtensionContext;
    const updates: string[] = [];
    const result = await answerAside(ctx, "Read example.txt", {
      signal: new AbortController().signal,
      onUpdate: (update) => updates.push(update.status), timeoutMs: 5000,
    });
    expect(result).toBe("The fixture says: Read-only fixture.");
    expect(requests).toBe(2);
    expect(updates).toContain("Reading · read");
    expect(updates).toContain("Answering…");
    expect(parent.getEntries()).toEqual(original);
    expect(await readFile(join(cwd, "example.txt"), "utf8")).toBe("Read-only fixture");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
