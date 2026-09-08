import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { answerAside } from "../src/side-session";

vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...await original<object>(),
  createAgentSession: vi.fn(),
}));

const create = vi.mocked(createAgentSession);
const message = (text: string, stopReason = "stop") => ({
  role: "assistant", content: [{ type: "text", text }], stopReason,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function harness() {
  const parent = SessionManager.inMemory("/tmp");
  parent.appendMessage({ role: "user", content: [{ type: "text", text: "Main task" }], timestamp: 1 });
  const ctx = {
    cwd: "/tmp", model: { id: "test-model" }, thinkingLevel: "high",
    modelRegistry: { runtime: {} }, sessionManager: parent,
    getSystemPrompt: () => "Main instructions\nCurrent date and time: old\nCurrent working directory: /old",
  } as unknown as ExtensionContext;
  const state = { messages: [] as any[] };
  let listener: (event: any) => void = () => {};
  const unsubscribe = vi.fn();
  const child = {
    state, agent: { state },
    subscribe: vi.fn((fn) => { listener = fn; return unsubscribe; }),
    prompt: vi.fn(async () => { state.messages.push(message("Fresh answer")); }),
    abort: vi.fn(async () => {}), dispose: vi.fn(),
  };
  create.mockResolvedValue({ session: child } as any);
  const onUpdate = vi.fn();
  const controller = new AbortController();
  const ask = (timeoutMs?: number) => answerAside(ctx, "Side question", { signal: controller.signal, onUpdate, timeoutMs });
  return { parent, ctx, child, ask, controller, onUpdate, unsubscribe, emit: (event: any) => listener(event) };
}

beforeEach(() => create.mockReset());
afterEach(() => vi.useRealTimers());

describe("throwaway aside", () => {
  it("inherits model/thinking/auth, deep-clones context and only enables read-only tools", async () => {
    const h = harness();
    const original = structuredClone(h.parent.getEntries());
    expect(await h.ask()).toBe("Fresh answer");
    const options = create.mock.calls[0][0]!;
    expect(options.model).toBe(h.ctx.model);
    expect(options.thinkingLevel).toBe("high");
    expect(options.modelRuntime).toBe((h.ctx.modelRegistry as any).runtime);
    expect(options.tools).toEqual(["read", "ls", "find", "grep"]);
    expect(options.sessionManager!.isPersisted()).toBe(false);
    expect(options.settingsManager!.getCompactionSettings().enabled).toBe(false);
    expect(options.settingsManager!.getRetrySettings().enabled).toBe(false);
    expect(options.resourceLoader!.getExtensions().extensions).toEqual([]);
    expect(options.resourceLoader!.getSkills().skills).toEqual([]);
    expect(options.resourceLoader!.getSystemPrompt()).toBe("Main instructions");
    expect(h.child.prompt).toHaveBeenCalledWith("Side question", { source: "extension", expandPromptTemplates: false });
    h.child.state.messages[0].content[0].text = "mutated clone";
    expect(h.parent.getEntries()).toEqual(original);
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.child.dispose).toHaveBeenCalledOnce());
  });

  it("captures fresh context before async creation and honors compaction and selected branch", async () => {
    const h = harness();
    const keep = h.parent.appendMessage({ role: "user", content: "Retained", timestamp: 2 });
    h.parent.appendCompaction("Earlier summary", keep, 1234);
    const leaf = h.parent.getLeafId()!;
    h.parent.appendMessage({ role: "user", content: "Other branch", timestamp: 3 });
    h.parent.branch(leaf);
    const pending = deferred<any>();
    create.mockReturnValueOnce(pending.promise);
    const answer = h.ask();
    h.parent.appendMessage({ role: "user", content: "Advanced during creation", timestamp: 4 });
    pending.resolve({ session: h.child });
    await answer;
    expect(JSON.stringify(h.child.state.messages)).toContain("Earlier summary");
    expect(JSON.stringify(h.child.state.messages)).toContain("Retained");
    expect(JSON.stringify(h.child.state.messages)).not.toMatch(/Main task|Other branch|Advanced during creation/);
    await h.ask();
    expect(JSON.stringify(h.child.state.messages)).toContain("Advanced during creation");
  });

  it("streams text and tool status, not thinking; resets text at each assistant turn", async () => {
    const h = harness();
    h.child.prompt.mockImplementation(async () => {
      h.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hidden" } });
      h.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Inspecting" } });
      h.emit({ type: "tool_execution_start", toolName: "read" });
      h.emit({ type: "message_start", message: { role: "assistant" } });
      h.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Answer" } });
      h.child.state.messages.push(message("Answer"));
    });
    expect(await h.ask()).toBe("Answer");
    expect(h.onUpdate.mock.calls.map(([update]) => update)).toEqual([
      { text: "Inspecting", status: "Answering…" },
      { text: "Inspecting", status: "Reading · read" },
      { text: "Answer", status: "Answering…" },
    ]);
  });

  it.each(["error", "aborted"])("reports model %s instead of accepting partial output", async (reason) => {
    const h = harness();
    h.child.prompt.mockImplementation(async () => { h.child.state.messages.push(message("partial", reason)); });
    await expect(h.ask()).rejects.toThrow(`Aside ${reason}`);
  });

  it("never mistakes an inherited assistant answer for a new answer", async () => {
    const h = harness();
    h.parent.appendMessage(message("Old answer") as any);
    h.child.prompt.mockImplementation(async () => {});
    await expect(h.ask()).rejects.toThrow("no response");
  });

  it("surfaces empty answers and creation failures", async () => {
    const h = harness();
    h.child.prompt.mockImplementation(async () => { h.child.state.messages.push(message("")); });
    await expect(h.ask()).rejects.toThrow("no answer text");
    create.mockRejectedValueOnce(new Error("No credentials"));
    await expect(h.ask()).rejects.toThrow("No credentials");
  });

  it("rejects missing models and already-cancelled requests without creating a child", async () => {
    const h = harness();
    h.controller.abort(new Error("Cancelled"));
    await expect(h.ask()).rejects.toThrow("Cancelled");
    expect(create).not.toHaveBeenCalled();
    const second = harness();
    (second.ctx as any).model = undefined;
    await expect(second.ask()).rejects.toThrow("No active model");
    expect(create).not.toHaveBeenCalled();
  });

  it("cancels during creation and disposes its late result without prompting", async () => {
    const h = harness();
    const pending = deferred<any>();
    create.mockReturnValueOnce(pending.promise);
    const answer = h.ask();
    h.controller.abort(new Error("Cancelled"));
    await expect(answer).rejects.toThrow("Cancelled");
    pending.resolve({ session: h.child });
    await vi.waitFor(() => expect(h.child.dispose).toHaveBeenCalledOnce());
    expect(h.child.prompt).not.toHaveBeenCalled();
  });

  it("cancels running work and suppresses late stream events", async () => {
    const h = harness();
    h.child.prompt.mockImplementation(() => new Promise(() => {}));
    const answer = h.ask();
    await vi.waitFor(() => expect(h.child.prompt).toHaveBeenCalled());
    h.controller.abort(new Error("Cancelled"));
    await expect(answer).rejects.toThrow("Cancelled");
    h.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Late" } });
    expect(h.onUpdate).not.toHaveBeenCalled();
    expect(h.child.abort).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.child.dispose).toHaveBeenCalledOnce());
  });

  it("applies the deadline to session creation as well as prompting", async () => {
    vi.useFakeTimers();
    const h = harness();
    create.mockReturnValueOnce(new Promise(() => {}));
    const result = expect(h.ask(10)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
