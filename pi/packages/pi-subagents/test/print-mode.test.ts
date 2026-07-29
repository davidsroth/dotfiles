import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
  };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("print mode subagents", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("persists and publishes foreground usage for cross-extension totals", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
      opts.onAssistantUsage?.({ input: 100, output: 25, cacheWrite: 5, cost: 0.42 });
      return {
        responseText: "done",
        session: { dispose: vi.fn() } as any,
        aborted: false,
        steered: false,
      };
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
        run_in_background: false,
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    expect(pi.events.emit).toHaveBeenCalledWith("subagents:usage", expect.objectContaining({
      cost: 0.42,
      usage: { input: 100, output: 25, cacheWrite: 5, cost: 0.42 },
    }));
    expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({
      usage: { input: 100, output: 25, cacheWrite: 5, cost: 0.42 },
    }));
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:completed", expect.objectContaining({
      cost: 0.42,
    }));

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });

  it("ignores stale-context errors from delayed completion nudges", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce
    await vi.advanceTimersByTimeAsync(200); // notification hold window

    expect(pi.sendMessage).toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });
});
