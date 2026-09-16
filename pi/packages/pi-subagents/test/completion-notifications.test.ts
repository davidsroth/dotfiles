import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function setup() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    on: (event: string, handler: any) => handlers.set(event, handler),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  const ctx = {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "notification-test", getBranch: () => [] },
    getSystemPrompt: () => "parent prompt",
  };
  subagentsExtension(pi as any);
  const emit = (event: string, payload = {}) => handlers.get(event)?.(payload, ctx);
  const call = (name: string, params: object) => tools.get(name).execute(name, params, undefined, undefined, ctx);
  const spawn = async (description = "background work") => {
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ responseText: `${description} result`, session: { dispose: vi.fn() } } as any);
    }));
    const result = await call("Agent", {
      prompt: description, description, subagent_type: "general-purpose", run_in_background: true,
    });
    return { id: result.details.agentId as string, finish };
  };
  return { pi, emit, call, spawn };
}

describe("completion notifications", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    vi.useFakeTimers();
    h = setup();
  });
  afterEach(async () => {
    await h.emit("session_shutdown");
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not enqueue a redundant follow-up when a result is read after the grace period", async () => {
    await h.emit("agent_start");
    const agent = await h.spawn();
    agent.finish();
    await vi.advanceTimersByTimeAsync(500);
    // Sending here hands the notification to Pi's non-cancellable follow-up queue.
    expect(h.pi.sendMessage).not.toHaveBeenCalled();

    const result = await h.call("get_subagent_result", { agent_id: agent.id, wait: true });
    expect(result.content[0].text).toContain("background work result");
    await h.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(h.pi.events.emit).toHaveBeenCalledWith("subagents:completed", expect.objectContaining({ id: agent.id }));
  });

  it("keeps actively awaited results silent", async () => {
    await h.emit("agent_start");
    const agent = await h.spawn();
    const waiting = h.call("get_subagent_result", { agent_id: agent.id, wait: true });
    agent.finish();
    expect((await waiting).content[0].text).toContain("background work result");
    await vi.advanceTimersByTimeAsync(500);
    await h.emit("agent_settled");
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("delivers unread results once the parent settles", async () => {
    await h.emit("agent_start");
    const agent = await h.spawn();
    agent.finish();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await h.emit("agent_settled");
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    expect(h.pi.sendMessage.mock.calls[0][0].details.id).toBe(agent.id);
    await h.emit("agent_settled");
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("still wakes an idle parent after the grace period", async () => {
    const agent = await h.spawn();
    await vi.advanceTimersByTimeAsync(100); // finalize single-agent batch
    agent.finish();
    await vi.advanceTimersByTimeAsync(199);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    expect(h.pi.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("retains the grace period across settlement and a new parent run", async () => {
    await h.emit("agent_start");
    const agent = await h.spawn();
    await vi.advanceTimersByTimeAsync(100);
    agent.finish();
    await vi.advanceTimersByTimeAsync(100);
    await h.emit("agent_settled");
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await h.emit("agent_start");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await h.emit("agent_settled");
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("clears held notifications on shutdown", async () => {
    await h.emit("agent_start");
    const agent = await h.spawn();
    agent.finish();
    await vi.advanceTimersByTimeAsync(500);
    await h.emit("session_shutdown");
    await h.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("filters consumed results from a group held past the grace period", async () => {
    await h.emit("agent_start");
    const first = await h.spawn("first");
    const second = await h.spawn("second");
    await vi.advanceTimersByTimeAsync(100); // form group before completion
    first.finish();
    second.finish();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await h.call("get_subagent_result", { agent_id: first.id, wait: true });
    await h.emit("agent_settled");
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    const message = h.pi.sendMessage.mock.calls[0][0];
    expect(message.details.id).toBe(second.id);
    expect(message.content).not.toContain(first.id);
    expect(message.details.others).toBeUndefined();
  });

  it("drops a held group when every result was consumed", async () => {
    await h.emit("agent_start");
    const first = await h.spawn("first");
    const second = await h.spawn("second");
    await vi.advanceTimersByTimeAsync(100);
    first.finish();
    second.finish();
    await vi.advanceTimersByTimeAsync(500);
    await h.call("get_subagent_result", { agent_id: first.id, wait: true });
    await h.call("get_subagent_result", { agent_id: second.id, wait: true });
    await h.emit("agent_settled");
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("returns the first selected agent to settle without consuming the others", async () => {
    await h.emit("agent_start");
    const first = await h.spawn("first");
    const second = await h.spawn("second");
    await vi.advanceTimersByTimeAsync(100);

    const waiting = h.call("get_subagent_result", {
      agent_ids: [first.id, second.id],
      wait: true,
    });
    second.finish();

    const result = await waiting;
    expect(result.content[0].text).toContain(`Agent: ${second.id}`);
    expect(result.content[0].text).toContain("second result");

    first.finish();
    await vi.advanceTimersByTimeAsync(500);
    await h.emit("agent_settled");

    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    const message = h.pi.sendMessage.mock.calls[0][0];
    expect(message.details.id).toBe(first.id);
    expect(message.content).not.toContain(second.id);
  });

  it("does not let a consumed race winner hold loser notification delivery until group timeout", async () => {
    await h.emit("agent_start");
    const first = await h.spawn("first");
    const second = await h.spawn("second");

    const waiting = h.call("get_subagent_result", {
      agent_ids: [first.id, second.id],
      wait: true,
    });
    second.finish();
    expect((await waiting).content[0].text).toContain(`Agent: ${second.id}`);
    first.finish();

    // Batch debounce + individual nudge grace, far shorter than group timeout.
    await vi.advanceTimersByTimeAsync(300);
    await h.emit("agent_settled");

    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    const message = h.pi.sendMessage.mock.calls[0][0];
    expect(message.details.id).toBe(first.id);
    expect(message.content).not.toContain(second.id);
  });

  it("keeps every selected notification live when a raced wait is interrupted", async () => {
    await h.emit("agent_start");
    const first = await h.spawn("first");
    const second = await h.spawn("second");
    await vi.advanceTimersByTimeAsync(100);

    const waiting = h.call("get_subagent_result", {
      agent_ids: [first.id, second.id],
      wait: true,
    });
    await h.emit("input", { source: "interactive", streamingBehavior: "steer", text: "stop waiting" });

    const result = await waiting;
    expect(result.content[0].text).toContain("Waiting was interrupted by a user message");
    first.finish();
    second.finish();
    await vi.advanceTimersByTimeAsync(500);
    await h.emit("agent_settled");

    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    const message = h.pi.sendMessage.mock.calls[0][0];
    expect(message.content).toContain(first.id);
    expect(message.content).toContain(second.id);
  });

  it("preserves notification delivery after an interrupted wait", async () => {
    await h.emit("agent_start");
    const agent = await h.spawn();
    const waiting = h.call("get_subagent_result", { agent_id: agent.id, wait: true });
    // Queue child completion before interrupting the wait. The abort path must
    // restore result ownership synchronously, before that completion runs.
    agent.finish();
    await h.emit("input", { source: "interactive", streamingBehavior: "steer", text: "stop waiting" });
    expect((await waiting).content[0].text).toContain("Waiting was interrupted");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await h.emit("agent_settled");
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
  });
});
