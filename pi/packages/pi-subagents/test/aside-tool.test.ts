import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const { answerSubagentAside, runAgent, steerAgent } = vi.hoisted(() => ({
  answerSubagentAside: vi.fn(),
  runAgent: vi.fn(),
  steerAgent: vi.fn(async () => {}),
}));

vi.mock("../src/agent-runner.js", () => ({
  getAgentConversation: vi.fn(() => ""),
  runAgent,
  steerAgent,
}));

vi.mock("../src/side-session.js", async () => {
  const actual = await vi.importActual<typeof import("../src/side-session.js")>("../src/side-session.js");
  return { ...actual, answerSubagentAside };
});

import subagentsExtension, {
  buildAsideLifecycleEventData,
  getAsideTargetError,
} from "../src/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function nestedUsage(): Usage {
  return {
    input: 11,
    output: 7,
    cacheRead: 3,
    cacheWrite: 2,
    totalTokens: 23,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
  };
}

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => handlers.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        eventHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return { pi, tools, handlers };
}

function makeCtx() {
  return {
    hasUI: false,
    mode: "print",
    cwd: "/tmp/parent-project",
    ui: { setStatus: vi.fn(), setWidget: vi.fn() },
    model: { provider: "test", id: "parent-model" },
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: {
      getSessionId: vi.fn(() => "root-session"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

function childSession() {
  return {
    prompt: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    dispose: vi.fn(),
    getSessionStats: vi.fn(() => ({
      tokens: { input: 0, output: 0, cacheWrite: 0 },
      contextUsage: { percent: 10 },
    })),
  } as any;
}

async function startInitializedAgent(tools: Map<string, any>, ctx: any, child: any) {
  runAgent.mockImplementation((_ctx: any, _type: string, _prompt: string, options: any) => {
    options.onSessionCreated?.(child);
    return new Promise(() => {});
  });
  const started = await tools.get("Agent").execute(
    "spawn-aside-target",
    {
      prompt: "keep working",
      description: "aside target",
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    undefined,
    undefined,
    ctx,
  );
  return started.details.agentId as string;
}

async function shutdown(handlers: Map<string, any>, ctx: any) {
  await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
}

afterEach(() => {
  vi.clearAllMocks();
  delete (globalThis as any)[MANAGER_KEY];
});

describe("aside_subagent tool", () => {
  it("uses the child worktree, returns nested usage, and emits privacy-safe telemetry", async () => {
    const { pi, tools, handlers } = makePi();
    const ctx = makeCtx();
    const child = childSession();
    const agentId = await startInitializedAgent(tools, ctx, child);
    const manager = (globalThis as any)[MANAGER_KEY];
    manager.getRecord(agentId).worktree = { path: "/tmp/agent-worktree", branch: "aside-test" };
    answerSubagentAside.mockResolvedValue({ answer: "three files remain", usage: nestedUsage() });

    const result = await tools.get("aside_subagent").execute(
      "aside-call",
      { agent_id: agentId, message: "SECRET QUESTION" },
      undefined,
      undefined,
      ctx,
    );

    expect(answerSubagentAside).toHaveBeenCalledWith(
      child,
      "SECRET QUESTION",
      expect.objectContaining({ cwd: "/tmp/agent-worktree", signal: expect.any(AbortSignal) }),
    );
    expect(result.content).toEqual([{ type: "text", text: "three files remain" }]);
    expect(result.usage).toEqual(nestedUsage());
    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:aside",
      expect.objectContaining({ id: agentId, durationMs: expect.any(Number), usage: nestedUsage() }),
    );
    const payload = pi.events.emit.mock.calls.find(([name]: [string]) => name === "subagents:aside")?.[1];
    expect(JSON.stringify(payload)).not.toContain("SECRET QUESTION");
    expect(JSON.stringify(payload)).not.toContain("three files remain");
    expect(child.prompt).not.toHaveBeenCalled();
    expect(child.steer).not.toHaveBeenCalled();
    expect(child.followUp).not.toHaveBeenCalled();
    expect(child.abort).not.toHaveBeenCalled();

    await shutdown(handlers, ctx);
  });

  it("rejects overlapping asides for the same target", async () => {
    const { tools, handlers } = makePi();
    const ctx = makeCtx();
    const child = childSession();
    const agentId = await startInitializedAgent(tools, ctx, child);
    let resolveAside!: (value: { answer: string; usage: Usage }) => void;
    answerSubagentAside.mockImplementation(() => new Promise((resolve) => {
      resolveAside = resolve;
    }));

    const first = tools.get("aside_subagent").execute(
      "aside-1",
      { agent_id: agentId, message: "first" },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(answerSubagentAside).toHaveBeenCalledOnce());
    const duplicate = await tools.get("aside_subagent").execute(
      "aside-2",
      { agent_id: agentId, message: "second" },
      undefined,
      undefined,
      ctx,
    );

    expect(duplicate.content[0].text).toContain("already in progress");
    expect(answerSubagentAside).toHaveBeenCalledOnce();
    resolveAside({ answer: "done", usage: nestedUsage() });
    await first;
    await shutdown(handlers, ctx);
  });

  it("forwards parent cancellation to the side session without aborting the child", async () => {
    const { tools, handlers } = makePi();
    const ctx = makeCtx();
    const child = childSession();
    const agentId = await startInitializedAgent(tools, ctx, child);
    const manager = (globalThis as any)[MANAGER_KEY];
    const controller = new AbortController();
    answerSubagentAside.mockImplementation((_child: any, _message: string, options: any) => (
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aside aborted")), { once: true });
      })
    ));

    const pending = tools.get("aside_subagent").execute(
      "aside-cancel",
      { agent_id: agentId, message: "cancel me" },
      controller.signal,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(answerSubagentAside).toHaveBeenCalledOnce());
    controller.abort();
    const result = await pending;

    expect(result.content[0].text).toContain("aside aborted");
    expect(child.abort).not.toHaveBeenCalled();
    expect(manager.getRecord(agentId).abortController.signal.aborted).toBe(false);
    await shutdown(handlers, ctx);
  });

  it("cancels an active side session during extension reload", async () => {
    const { tools, handlers } = makePi();
    const ctx = makeCtx();
    const child = childSession();
    const agentId = await startInitializedAgent(tools, ctx, child);
    let sideSignal: AbortSignal | undefined;
    answerSubagentAside.mockImplementation((_child: any, _message: string, options: any) => {
      sideSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aside aborted")), { once: true });
      });
    });

    const pending = tools.get("aside_subagent").execute(
      "aside-reload",
      { agent_id: agentId, message: "still there?" },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(answerSubagentAside).toHaveBeenCalledOnce());
    await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
    const result = await pending;

    expect(sideSignal?.aborted).toBe(true);
    expect(result.content[0].text).toContain("aside aborted");
  });

  it("rejects unknown, queued, and uninitialized targets clearly", async () => {
    const { tools, handlers } = makePi();
    const ctx = makeCtx();
    runAgent.mockImplementation(() => new Promise(() => {}));

    const unknown = await tools.get("aside_subagent").execute(
      "aside-unknown",
      { agent_id: "missing", message: "hello" },
      undefined,
      undefined,
      ctx,
    );
    expect(unknown.content[0].text).toContain("Agent not found");

    const started = await tools.get("Agent").execute(
      "spawn-uninitialized",
      {
        prompt: "wait",
        description: "uninitialized target",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    const agentId = started.details.agentId;

    const uninitialized = await tools.get("aside_subagent").execute(
      "aside-uninitialized",
      { agent_id: agentId, message: "hello" },
      undefined,
      undefined,
      ctx,
    );
    expect(uninitialized.content[0].text).toContain("session is not initialized");

    // A queued record has no session by definition; status must take priority
    // over the more transient uninitialized-running diagnostic.
    (globalThis as any)[MANAGER_KEY].getRecord(agentId).status = "queued";
    const queued = await tools.get("aside_subagent").execute(
      "aside-queued",
      { agent_id: agentId, message: "hello" },
      undefined,
      undefined,
      ctx,
    );
    expect(queued.content[0].text).toContain("status: queued");
    expect(answerSubagentAside).not.toHaveBeenCalled();
    await shutdown(handlers, ctx);
  });

  it("leaves steering behavior unchanged", async () => {
    const { tools, handlers } = makePi();
    const ctx = makeCtx();
    const child = childSession();
    const agentId = await startInitializedAgent(tools, ctx, child);

    const result = await tools.get("steer_subagent").execute(
      "steer-call",
      { agent_id: agentId, message: "change direction" },
      undefined,
      undefined,
      ctx,
    );

    expect(steerAgent).toHaveBeenCalledWith(child, "change direction");
    expect(result.content[0].text).toContain("Steering message sent");
    expect(answerSubagentAside).not.toHaveBeenCalled();
    await shutdown(handlers, ctx);
  });
});

describe("aside validation and telemetry helpers", () => {
  it.each(["queued", "completed", "stopped", "error"])(
    "rejects %s records as non-running",
    (status) => {
      const message = getAsideTargetError({ status } as any, "agent-1");
      expect(message).toContain(`status: ${status}`);
    },
  );

  it("accepts only initialized running records", () => {
    expect(getAsideTargetError({ status: "running" } as any, "agent-1"))
      .toContain("session is not initialized");
    expect(getAsideTargetError({ status: "running", session: {} } as any, "agent-1"))
      .toBeUndefined();
  });

  it("builds telemetry without accepting question or answer fields", () => {
    const payload = buildAsideLifecycleEventData("agent-1", 42, nestedUsage());
    expect(payload).toEqual({ id: "agent-1", durationMs: 42, usage: nestedUsage() });
    expect(Object.keys(payload)).toEqual(["id", "durationMs", "usage"]);
  });
});
