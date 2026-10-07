import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { answerAside, createAsideThread } from "../src/side-session";

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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
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
    prompt: vi.fn(async (_question: string, _options?: unknown) => { state.messages.push(message("Fresh answer")); }),
    abort: vi.fn(async () => {}), dispose: vi.fn(),
  };
  create.mockImplementation(async (options) => {
    state.messages = options!.sessionManager!.buildSessionContext().messages;
    return { session: child } as any;
  });
  const onUpdate = vi.fn();
  const controller = new AbortController();
  const ask = (timeoutMs?: number) => answerAside(ctx, "Side question", { signal: controller.signal, onUpdate, timeoutMs });
  return { parent, ctx, child, ask, controller, onUpdate, unsubscribe, emit: (event: any) => listener(event) };
}

beforeEach(() => { create.mockReset(); });
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
    expect(options.sessionManager!.buildSessionContext().messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "Main task" }] });
    expect(options.settingsManager!.getCompactionSettings().enabled).toBe(false);
    expect(options.settingsManager!.getRetrySettings().enabled).toBe(false);
    expect(options.resourceLoader!.getExtensions().extensions).toEqual([]);
    expect(options.resourceLoader!.getSkills().skills).toEqual([]);
    expect(options.resourceLoader!.getSystemPrompt()).toBe("Main instructions");
    expect(h.child.prompt).toHaveBeenCalledWith("Side question", {
      source: "extension", expandPromptTemplates: false, preflightResult: expect.any(Function),
    });
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
    h.child.state.messages = create.mock.calls[0][0]!.sessionManager!.buildSessionContext().messages;
    pending.resolve({ session: h.child });
    await answer;
    expect(JSON.stringify(create.mock.calls[0][0]!.sessionManager!.buildSessionContext().messages)).toContain("Earlier summary");
    expect(JSON.stringify(h.child.state.messages)).toContain("Earlier summary");
    expect(JSON.stringify(h.child.state.messages)).toContain("Retained");
    expect(JSON.stringify(h.child.state.messages)).not.toMatch(/Main task|Other branch|Advanced during creation/);
    expect(create.mock.calls[0][0]!.sessionManager!.getBranch().some((entry) =>
      JSON.stringify(entry).includes("Other branch"))).toBe(false);
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
      { text: "", status: "Thinking…" },
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
    expect(h.onUpdate).toHaveBeenCalledExactlyOnceWith({ text: "", status: "Thinking…" });
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

describe("retained aside thread", () => {
  it("snapshots at thread creation, retaining aside exchanges but not later parent/model/prompt changes", async () => {
    const h = harness();
    const original = structuredClone(h.parent.getEntries());
    const thread = createAsideThread(h.ctx, h.controller.signal);
    expect(create).not.toHaveBeenCalled();
    h.parent.appendMessage({ role: "user", content: "Later main work", timestamp: 2 });
    (h.ctx as any).model = { id: "later-model" };
    (h.ctx as any).thinkingLevel = "off";
    (h.ctx as any).getSystemPrompt = () => "Later instructions";
    h.child.prompt.mockImplementation(async (question: string) => {
      h.child.state.messages.push({ role: "user", content: question });
      h.child.state.messages.push(message(`Answer to ${question}`));
    });
    try {
      expect(await thread.ask("First", { onUpdate: h.onUpdate })).toBe("Answer to First");
      expect(h.child.dispose).not.toHaveBeenCalled();
      expect(await thread.ask("Second", { onUpdate: h.onUpdate })).toBe("Answer to Second");
      expect(create).toHaveBeenCalledOnce();
      const options = create.mock.calls[0][0]!;
      expect(options.model).toEqual({ id: "test-model" });
      expect(options.thinkingLevel).toBe("high");
      expect(options.resourceLoader!.getSystemPrompt()).toBe("Main instructions");
      expect(h.child.state.messages.map((m) => m.role)).toEqual(["user", "user", "assistant", "user", "assistant"]);
      expect(JSON.stringify(h.child.state.messages)).not.toContain("Later main work");
      h.child.state.messages[0].content[0].text = "Clone only";
      expect(h.parent.getEntries().slice(0, original.length)).toEqual(original);
      expect(h.unsubscribe).toHaveBeenCalledTimes(2);
    } finally { thread.dispose(); }
    await vi.waitFor(() => expect(h.child.dispose).toHaveBeenCalledOnce());
  });

  it("queues busy submissions FIFO, starts updates only when active and isolates response/stream boundaries", async () => {
    const h = harness();
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const listeners: ((event: any) => void)[] = [];
    h.child.subscribe.mockImplementation((fn) => { listeners.push(fn); return h.unsubscribe; });
    h.child.prompt.mockImplementation(async (question: string) => {
      const index = h.child.prompt.mock.calls.length - 1;
      listeners[index]({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: question } });
      await gates[index].promise;
      h.child.state.messages.push(message(`${question} answer`));
    });
    const thread = createAsideThread(h.ctx, h.controller.signal);
    const updates = [vi.fn(), vi.fn(), vi.fn()];
    const answers = updates.map((onUpdate, index) => thread.ask(`Q${index}`, { onUpdate }));
    try {
      await vi.waitFor(() => expect(h.child.prompt).toHaveBeenCalledTimes(1));
      expect(updates[0].mock.calls.map(([u]) => u)).toEqual([
        { text: "", status: "Thinking…" }, { text: "Q0", status: "Answering…" },
      ]);
      expect(updates[1]).not.toHaveBeenCalled();
      expect(updates[2]).not.toHaveBeenCalled();
      gates[0].resolve();
      expect(await answers[0]).toBe("Q0 answer");
      await vi.waitFor(() => expect(h.child.prompt).toHaveBeenCalledTimes(2));
      listeners[0]({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Late old turn" } });
      expect(updates[0]).toHaveBeenCalledTimes(2);
      expect(updates[1].mock.calls.map(([u]) => u)).toEqual([
        { text: "", status: "Thinking…" }, { text: "Q1", status: "Answering…" },
      ]);
      gates[1].resolve();
      expect(await answers[1]).toBe("Q1 answer");
      gates[2].resolve();
      expect(await answers[2]).toBe("Q2 answer");
      expect(h.child.prompt.mock.calls.map(([q]) => q)).toEqual(["Q0", "Q1", "Q2"]);
      expect(create).toHaveBeenCalledOnce();
    } finally { thread.dispose(); }
  });

  it("never reuses the previous aside answer for an empty later turn", async () => {
    const h = harness();
    const thread = createAsideThread(h.ctx, h.controller.signal);
    try {
      await thread.ask("First", { onUpdate: h.onUpdate });
      h.child.prompt.mockImplementation(async () => {});
      await expect(thread.ask("Second", { onUpdate: h.onUpdate })).rejects.toThrow("no response");
      h.child.prompt.mockImplementation(async () => { h.child.state.messages.push(message("")); });
      await expect(thread.ask("Third", { onUpdate: h.onUpdate })).rejects.toThrow("no answer text");
    } finally { thread.dispose(); }
  });

  it("allows a queued follow-up after a settled provider error, without recreating the child", async () => {
    const h = harness();
    h.child.prompt.mockImplementationOnce(async () => { h.child.state.messages.push(message("partial", "error")); });
    const thread = createAsideThread(h.ctx, h.controller.signal);
    try {
      const failed = thread.ask("First", { onUpdate: h.onUpdate });
      const next = thread.ask("Second", { onUpdate: h.onUpdate });
      await expect(failed).rejects.toThrow("Aside error");
      expect(await next).toBe("Fresh answer");
      expect(create).toHaveBeenCalledOnce();
      expect(h.child.dispose).not.toHaveBeenCalled();
    } finally { thread.dispose(); }
  });

  it("makes model aborts terminal and rejects queued/future turns without starting them", async () => {
    const h = harness();
    h.child.prompt.mockImplementationOnce(async () => { h.child.state.messages.push(message("partial", "aborted")); });
    const thread = createAsideThread(h.ctx, h.controller.signal);
    const nextUpdate = vi.fn();
    const failed = thread.ask("First", { onUpdate: h.onUpdate });
    const next = thread.ask("Second", { onUpdate: nextUpdate });
    await expect(failed).rejects.toThrow("Aside aborted");
    await expect(next).rejects.toThrow("Aside aborted");
    await expect(thread.ask("Third", { onUpdate: nextUpdate })).rejects.toThrow("Aside aborted");
    expect(nextUpdate).not.toHaveBeenCalled();
    expect(h.child.prompt).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.child.dispose).toHaveBeenCalledOnce());
  });

  it("terminates on a rejected prompt that leaves streaming work", async () => {
    const h = harness();
    (h.child as any).isStreaming = true;
    h.child.prompt.mockRejectedValueOnce(new Error("Still running"));
    const thread = createAsideThread(h.ctx, h.controller.signal);
    const first = thread.ask("First", { onUpdate: h.onUpdate });
    const second = thread.ask("Second", { onUpdate: vi.fn() });
    await expect(first).rejects.toThrow("Still running");
    await expect(second).rejects.toThrow("Still running");
    expect(h.child.prompt).toHaveBeenCalledOnce();
  });

  it.each(["dispose", "abort"])("%s rejects active and queued work immediately, stops callbacks, and waits for abort cleanup", async (action) => {
    const h = harness();
    const prompting = deferred<void>();
    const aborting = deferred<void>();
    h.child.prompt.mockReturnValueOnce(prompting.promise);
    h.child.abort.mockReturnValueOnce(aborting.promise);
    const thread = createAsideThread(h.ctx, h.controller.signal);
    const queuedUpdate = vi.fn();
    const first = thread.ask("First", { onUpdate: h.onUpdate });
    const next = thread.ask("Second", { onUpdate: queuedUpdate });
    await vi.waitFor(() => expect(h.child.prompt).toHaveBeenCalled());
    if (action === "dispose") thread.dispose();
    else h.controller.abort(new Error("Lifecycle cancelled"));
    const reason = action === "dispose" ? "disposed" : "Lifecycle cancelled";
    await expect(first).rejects.toThrow(reason);
    await expect(next).rejects.toThrow(reason);
    await expect(thread.ask("Third", { onUpdate: queuedUpdate })).rejects.toThrow(reason);
    h.emit({ type: "tool_execution_start", toolName: "read" });
    h.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Late" } });
    expect(h.onUpdate).toHaveBeenCalledExactlyOnceWith({ text: "", status: "Thinking…" });
    expect(queuedUpdate).not.toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(h.child.dispose).not.toHaveBeenCalled();
    thread.dispose();
    aborting.resolve();
    prompting.resolve();
    await vi.waitFor(() => expect(h.child.dispose).toHaveBeenCalledOnce());
    expect(h.child.abort).toHaveBeenCalledOnce();
  });

  it("safely disposes creation resolving in the same tick as cancellation, without prompting or unhandled rejection", async () => {
    const h = harness();
    const pending = deferred<any>();
    create.mockReturnValueOnce(pending.promise);
    const thread = createAsideThread(h.ctx, h.controller.signal);
    // Intentionally discard these promises as a dismissed UI may do.
    void thread.ask("First", { onUpdate: h.onUpdate });
    void thread.ask("Second", { onUpdate: vi.fn() });
    pending.resolve({ session: h.child });
    h.controller.abort(new Error("Cancelled"));
    await vi.waitFor(() => expect(h.child.dispose).toHaveBeenCalledOnce());
    expect(h.child.prompt).not.toHaveBeenCalled();
    thread.dispose();
    await expect(thread.ask("Later", { onUpdate: vi.fn() })).rejects.toThrow("Cancelled");
  });

  it("handles a late rejected creation after disposal without unhandled rejection", async () => {
    const h = harness();
    const pending = deferred<any>();
    create.mockReturnValueOnce(pending.promise);
    const thread = createAsideThread(h.ctx, h.controller.signal);
    const first = thread.ask("First", { onUpdate: h.onUpdate });
    thread.dispose();
    await expect(first).rejects.toThrow("disposed");
    pending.reject(new Error("Late factory error"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.child.prompt).not.toHaveBeenCalled();
  });

  it("has no idle deadline, gives each queued turn its own full deadline, and clears timers after each answer", async () => {
    vi.useFakeTimers();
    const h = harness();
    const gates = [deferred<void>(), deferred<void>()];
    h.child.prompt.mockImplementation(async (q: string) => {
      await gates[h.child.prompt.mock.calls.length - 1].promise;
      h.child.state.messages.push(message(q));
    });
    const thread = createAsideThread(h.ctx, h.controller.signal);
    expect(vi.getTimerCount()).toBe(0);
    const first = thread.ask("First", { onUpdate: h.onUpdate, timeoutMs: 100 });
    const nextUpdate = vi.fn();
    const second = thread.ask("Second", { onUpdate: nextUpdate, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(50);
    expect(nextUpdate).not.toHaveBeenCalled();
    gates[0].resolve();
    expect(await first).toBe("First");
    expect(nextUpdate).toHaveBeenCalledExactlyOnceWith({ text: "", status: "Thinking…" });
    await vi.advanceTimersByTimeAsync(9);
    gates[1].resolve();
    expect(await second).toBe("Second");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.child.abort).not.toHaveBeenCalled();
    thread.dispose();
    await Promise.resolve();
    expect(h.child.dispose).toHaveBeenCalledOnce();
  });

  it("starts the default five-minute deadline at activation, including creation, and disposes its late child", async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = deferred<any>();
    create.mockReturnValueOnce(pending.promise);
    const thread = createAsideThread(h.ctx, h.controller.signal);
    const first = thread.ask("First", { onUpdate: h.onUpdate });
    const nextUpdate = vi.fn();
    const second = thread.ask("Second", { onUpdate: nextUpdate });
    const firstCheck = expect(first).rejects.toThrow("timed out");
    const secondCheck = expect(second).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(299_999);
    expect(h.child.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([firstCheck, secondCheck]);
    expect(vi.getTimerCount()).toBe(0);
    expect(nextUpdate).not.toHaveBeenCalled();
    pending.resolve({ session: h.child });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.child.dispose).toHaveBeenCalledOnce();
    expect(h.child.prompt).not.toHaveBeenCalled();
  });

  it("applies a new deadline to retained follow-ups and suppresses events after its timeout", async () => {
    vi.useFakeTimers();
    const h = harness();
    const thread = createAsideThread(h.ctx, h.controller.signal);
    await thread.ask("First", { onUpdate: h.onUpdate, timeoutMs: 10 });
    h.child.prompt.mockImplementation(() => new Promise(() => {}));
    const updates = vi.fn();
    const second = thread.ask("Second", { onUpdate: updates, timeoutMs: 10 });
    const third = thread.ask("Third", { onUpdate: vi.fn() });
    const checks = [expect(second).rejects.toThrow("timed out"), expect(third).rejects.toThrow("timed out")];
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(checks);
    h.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Too late" } });
    expect(updates).toHaveBeenCalledExactlyOnceWith({ text: "", status: "Thinking…" });
    expect(h.child.prompt).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
    expect(h.child.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can be disposed before first ask and rejects missing auth runtime synchronously", async () => {
    const h = harness();
    const thread = createAsideThread(h.ctx, h.controller.signal);
    thread.dispose();
    thread.dispose();
    await expect(thread.ask("First", { onUpdate: h.onUpdate })).rejects.toThrow("disposed");
    expect(h.onUpdate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    (h.ctx as any).modelRegistry = {};
    expect(() => createAsideThread(h.ctx, h.controller.signal)).toThrow("runtime is unavailable");
  });
});
