import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall,
  InMemoryCredentialStore, InMemoryModelsStore, type Context,
} from "@earendil-works/pi-ai";
import { AgentSession, ModelRegistry, ModelRuntime, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { answerAside, createAsideThread } from "../src/side-session";

// 0.85.x exposes prompt/tools on Context; 1.0.x normalizes them into system
// transcript declarations. Verify the effective provider loadout in either SDK.
function providerContext(context: Context) {
  const declarations = context.messages as unknown as Array<{
    role: string; content: unknown; sections?: Record<string, string | null>;
    toolsAdded?: Array<{ name: string }>; toolsRemoved?: Array<{ name: string }>;
  }>;
  const systems = declarations.filter((message) => message.role === "system");
  const tools = new Map((context.tools ?? []).map((tool) => [tool.name, tool]));
  for (const system of systems) {
    for (const tool of system.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of system.toolsAdded ?? []) tools.set(tool.name, tool as any);
  }
  return {
    messages: context.messages.filter((message) => (message.role as string) !== "system"),
    toolNames: [...tools.keys()].sort(),
    systemPrompt: context.systemPrompt ?? systems.map((message) => JSON.stringify([message.content, message.sections])).join("\n"),
  };
}

it("retains a real SDK conversation through read tools and queued follow-ups, leaving parent and disk untouched", async () => {
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
    // 1.0.x stores tool declarations in the transcript. Inherited main-session
    // write tools must be removed from the child provider's effective loadout.
    if ("buildSessionProjection" in parent) {
      parent.appendMessage({
        role: "system", content: "Main tool loadout", timestamp: 0,
        toolsAdded: ["write", "bash"].map((name) => ({
          name, description: "Main-session action", parameters: { type: "object", properties: {} },
        })),
      } as any);
    }
    parent.appendMessage({ role: "user", content: "Main session sentinel", timestamp: 1 });
    parent.appendMessage(fauxAssistantMessage("Earlier answer"));
    parent.appendMessage({ role: "user", content: "Follow-up context", timestamp: 2 });
    const original = structuredClone(parent.getEntries());
    let requests = 0;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    faux.setResponses([
      async (context, options) => {
        requests++;
        const projected = providerContext(context);
        expect(projected.toolNames).toEqual(["find", "grep", "ls", "read"]);
        expect(projected.messages.slice(0, 3).map((message) => message.role)).toEqual(["user", "assistant", "user"]);
        expect(JSON.stringify(projected.messages.slice(0, 3))).toContain("Earlier answer");
        expect(JSON.stringify(projected.messages.slice(0, 3))).toContain("Follow-up context");
        expect(projected.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "Read example.txt" }] });
        expect(projected.systemPrompt).toContain("separate, retained conversation");
        expect(options?.reasoning).toBe("high");
        entered();
        await gate;
        return fauxAssistantMessage(fauxToolCall("read", { path: "example.txt" }), { stopReason: "toolUse" });
      },
      (context) => {
        requests++;
        const projected = providerContext(context);
        expect(projected.messages.slice(0, 3).map((message) => message.role)).toEqual(["user", "assistant", "user"]);
        expect(JSON.stringify(projected.messages.slice(0, 3))).toContain("Earlier answer");
        expect(JSON.stringify(projected.messages.slice(0, 3))).toContain("Follow-up context");
        expect(projected.toolNames).toEqual(["find", "grep", "ls", "read"]);
        const toolResult = projected.messages.find((message) => message.role === "toolResult");
        expect(JSON.stringify(toolResult)).toContain("Read-only fixture");
        return fauxAssistantMessage("The fixture says: Read-only fixture.");
      },
      (context) => {
        requests++;
        const history = JSON.stringify(context.messages);
        expect(history).toContain("Earlier answer");
        expect(history).toContain("Read example.txt");
        expect(history).toContain("The fixture says: Read-only fixture.");
        expect(history).toContain("Read-only fixture");
        expect(history).not.toMatch(/Later main work|Mutated main context/);
        expect(context.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "What did you find?" }] });
        return fauxAssistantMessage("It was a read-only fixture.");
      },
    ]);
    const ctx = {
      cwd, model: faux.getModel(), thinkingLevel: "high", modelRegistry: new ModelRegistry(runtime),
      sessionManager: parent, getSystemPrompt: () => "Main system instructions",
    } as unknown as ExtensionContext;
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const thread = createAsideThread(ctx, new AbortController().signal);
    const updates: string[] = [];
    const nextUpdates = vi.fn();
    try {
      const first = thread.ask("Read example.txt", { onUpdate: (update) => updates.push(update.status), timeoutMs: 5000 });
      const second = thread.ask("What did you find?", { onUpdate: nextUpdates, timeoutMs: 5000 });
      // Faux turns assertion failures into provider errors. Surface them instead
      // of hanging on a synchronization point the callback never reached.
      await Promise.race([started, first.then(() => { throw new Error("Provider did not reach its gate"); })]);
      expect(nextUpdates).not.toHaveBeenCalled();
      // These changes happen while the first turn is busy, after thread creation.
      parent.appendMessage({ role: "user", content: "Later main work", timestamp: 3 });
      (parent.getEntries()[0] as any).message.content = "Mutated main context";
      const advancedParent = structuredClone(parent.getEntries());
      finish();
      expect(await first).toBe("The fixture says: Read-only fixture.");
      expect(await second).toBe("It was a read-only fixture.");
      expect(requests).toBe(3);
      expect(updates[0]).toBe("Thinking…");
      expect(updates).toContain("Reading · read");
      expect(updates).toContain("Answering…");
      expect(nextUpdates.mock.calls[0][0]).toEqual({ text: "", status: "Thinking…" });
      expect(nextUpdates.mock.calls.at(-1)![0].text).toBe("It was a read-only fixture.");
      expect(parent.getEntries()).toEqual(advancedParent);
      expect(parent.getEntries().length).toBe(original.length + 1);
      expect(await readFile(join(cwd, "example.txt"), "utf8")).toBe("Read-only fixture");
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      finish();
      thread.dispose();
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
      dispose.mockRestore();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-aside-sdk-"));
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: "aside-test", reasoning: true }], tokensPerSecond: 100_000 });
  runtime.registerNativeProvider(faux.provider);
  const parent = SessionManager.inMemory(cwd);
  parent.appendMessage({ role: "user", content: "Original main context", timestamp: 1 });
  const ctx = {
    cwd, model: faux.getModel(), thinkingLevel: "high", modelRegistry: new ModelRegistry(runtime),
    sessionManager: parent, getSystemPrompt: () => "Main instructions",
  } as unknown as ExtensionContext;
  return { cwd, faux, parent, ctx, runtime };
}

it("keeps the one-shot SDK wrapper disposable and read-only", async () => {
  const h = await fixture();
  const dispose = vi.spyOn(AgentSession.prototype, "dispose");
  try {
    const original = structuredClone(h.parent.getEntries());
    h.faux.setResponses([fauxAssistantMessage("One-shot answer")]);
    expect(await answerAside(h.ctx, "One question", {
      signal: new AbortController().signal, onUpdate: () => {}, timeoutMs: 5000,
    })).toBe("One-shot answer");
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect((dispose.mock.contexts[0] as AgentSession).sessionManager.isPersisted()).toBe(false);
    expect(h.parent.getEntries()).toEqual(original);
  } finally {
    dispose.mockRestore();
    await rm(h.cwd, { recursive: true, force: true });
  }
});

it("can recover from a settled real SDK provider error without treating earlier text as the next answer", async () => {
  const h = await fixture();
  const dispose = vi.spyOn(AgentSession.prototype, "dispose");
  const thread = createAsideThread(h.ctx, new AbortController().signal);
  try {
    h.faux.setResponses([
      fauxAssistantMessage("First answer"),
      fauxAssistantMessage("Partial", { stopReason: "error", errorMessage: "Provider failed" }),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("First answer");
        expect(context.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "Try again" }] });
        return fauxAssistantMessage("Recovered answer");
      },
    ]);
    expect(await thread.ask("First", { onUpdate: () => {}, timeoutMs: 5000 })).toBe("First answer");
    const failing = thread.ask("Fails", { onUpdate: () => {}, timeoutMs: 5000 });
    const retry = thread.ask("Try again", { onUpdate: () => {}, timeoutMs: 5000 });
    await expect(failing).rejects.toThrow("Provider failed");
    expect(await retry).toBe("Recovered answer");
    expect(h.faux.state.callCount).toBe(3);
    expect(dispose).not.toHaveBeenCalled();
  } finally {
    thread.dispose();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    dispose.mockRestore();
    await rm(h.cwd, { recursive: true, force: true });
  }
});

it.each(["abort", "dispose", "timeout"])("%s terminates a real SDK active turn and its queue and suppresses late provider output", async (action) => {
  const h = await fixture();
  const dispose = vi.spyOn(AgentSession.prototype, "dispose");
  const controller = new AbortController();
  const thread = createAsideThread(h.ctx, controller.signal);
  let entered!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => { entered = resolve; });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const updates = vi.fn();
  const nextUpdates = vi.fn();
  h.faux.setResponses([
    async (_context, options) => {
      entered(options!.signal!);
      await gate;
      return fauxAssistantMessage("Too late to show");
    },
    fauxAssistantMessage("Must not run"),
  ]);
  try {
    const original = structuredClone(h.parent.getEntries());
    const first = thread.ask("Slow question", { onUpdate: updates, timeoutMs: action === "timeout" ? 150 : 5000 });
    const second = thread.ask("Queued question", { onUpdate: nextUpdates, timeoutMs: 5000 });
    const providerSignal = await started;
    if (action === "abort") controller.abort(new Error("Lifecycle abort"));
    if (action === "dispose") thread.dispose();
    const reason = action === "abort" ? "Lifecycle abort" : action === "dispose" ? "disposed" : "timed out";
    await expect(first).rejects.toThrow(reason);
    await expect(second).rejects.toThrow(reason);
    await expect(thread.ask("Later", { onUpdate: nextUpdates })).rejects.toThrow(reason);
    expect(providerSignal.aborted).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    const before = updates.mock.calls.length;
    finish();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(updates).toHaveBeenCalledTimes(before);
    expect(nextUpdates).not.toHaveBeenCalled();
    expect(h.faux.state.callCount).toBe(1);
    expect(h.parent.getEntries()).toEqual(original);
  } finally {
    finish();
    thread.dispose();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    dispose.mockRestore();
    await rm(h.cwd, { recursive: true, force: true });
  }
});

it("cancels while real SDK prompt auth preflight is pending without starting a late provider request", async () => {
  const h = await fixture();
  const dispose = vi.spyOn(AgentSession.prototype, "dispose");
  const configured = vi.spyOn(h.runtime, "hasConfiguredAuth").mockReturnValue(false);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const auth = h.runtime.checkAuth.bind(h.runtime);
  const check = vi.spyOn(h.runtime, "checkAuth").mockImplementation(async (...args) => {
    entered();
    await gate;
    return auth(...args);
  });
  const controller = new AbortController();
  const thread = createAsideThread(h.ctx, controller.signal);
  try {
    h.faux.setResponses([fauxAssistantMessage("Must not run")]);
    const first = thread.ask("Pending auth", { onUpdate: () => {}, timeoutMs: 5000 });
    const second = thread.ask("Queued", { onUpdate: () => {}, timeoutMs: 5000 });
    await started;
    controller.abort(new Error("Cancelled in preflight"));
    await expect(first).rejects.toThrow("Cancelled in preflight");
    await expect(second).rejects.toThrow("Cancelled in preflight");
    finish();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    // Auth may resolve after SDK abort() has already returned idle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.faux.state.callCount).toBe(0);
  } finally {
    finish();
    thread.dispose();
    configured.mockRestore();
    check.mockRestore();
    dispose.mockRestore();
    await rm(h.cwd, { recursive: true, force: true });
  }
});
