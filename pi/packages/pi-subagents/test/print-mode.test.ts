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
import { PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY } from "../src/pi-vim-left-arrow.js";

const originalPiVimRegistry = (globalThis as Record<PropertyKey, unknown>)[
  PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY
];

function makePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn((name: string, command: any) => {
        commands.set(name, command);
      }),
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
    commands,
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
    (globalThis as Record<PropertyKey, unknown>)[PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY] = originalPiVimRegistry;
  });

  it("registers the pi-vim hook only for the current root TUI session and cleans it up", async () => {
    (globalThis as Record<PropertyKey, unknown>)[PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY] = undefined;
    const { pi, handlers } = makePi();
    subagentsExtension(pi);
    const ctx = {
      ...makeHeadlessCtx(),
      mode: "tui",
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
    } as any;

    await handlers.get("session_start")?.({}, ctx);
    const registry = (globalThis as Record<PropertyKey, any>)[PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY];

    expect(registry.handleNormalLeftArrow()).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith("No active subagents.", "info");

    ctx.sessionManager.getSessionId.mockReturnValue("different-session");
    expect(registry.handleNormalLeftArrow()).toBe(false);
    await handlers.get("session_shutdown")?.({}, ctx);
    expect(registry.handleNormalLeftArrow()).toBe(false);
  });

  it("does not register the pi-vim hook from non-TUI child sessions", async () => {
    (globalThis as Record<PropertyKey, unknown>)[PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY] = undefined;
    const { pi, handlers } = makePi();
    subagentsExtension(pi);

    await handlers.get("session_start")?.({}, { ...makeHeadlessCtx(), mode: "print" });

    expect((globalThis as Record<PropertyKey, unknown>)[PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY]).toBeUndefined();
  });

  it("lets a user message interrupt a wait without stopping the background agent", async () => {
    let completeAgent!: (result: { responseText: string; session: { dispose: ReturnType<typeof vi.fn> } }) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((resolve) => {
      completeAgent = resolve;
    }));
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    const ctx = makeHeadlessCtx();

    const started = await tools.get("Agent").execute(
      "background-agent",
      {
        prompt: "wait for a result",
        description: "interruptible wait",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    const agentId = started.details.agentId;
    const waiting = tools.get("get_subagent_result").execute(
      "wait-for-agent",
      { agent_id: agentId, wait: true },
      undefined,
      undefined,
      ctx,
    );

    await handlers.get("input")?.({
      source: "interactive",
      streamingBehavior: "steer",
      text: "interrupt this wait",
    }, ctx);

    const interrupted = await waiting;
    expect(interrupted.content[0].text).toContain("Waiting was interrupted by a user message");

    completeAgent({ responseText: "finished after interrupt", session: { dispose: vi.fn() } });
    await vi.waitFor(() => expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:completed",
      expect.objectContaining({ id: agentId }),
    ));

    const completed = await tools.get("get_subagent_result").execute(
      "retrieve-agent",
      { agent_id: agentId },
      undefined,
      undefined,
      ctx,
    );
    expect(completed.content[0].text).toContain("finished after interrupt");

    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("registers /agents as the focused viewer and keeps management separate", async () => {
    const { pi, commands, handlers } = makePi();
    subagentsExtension(pi);
    const ctx = {
      ...makeHeadlessCtx(),
      hasUI: true,
      ui: {
        notify: vi.fn(),
        custom: vi.fn(),
        select: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      },
    } as any;

    expect(commands.get("agents").description).toBe("View and steer active subagents");
    expect(commands.get("agent-manage").description).toBe("Manage agent types, schedules, and settings");

    await commands.get("agents").handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("No active subagents.", "info");
    expect(ctx.ui.select).not.toHaveBeenCalled();
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("focuses the existing agents widget instead of opening another custom surface", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools, commands, handlers } = makePi();
    subagentsExtension(pi);

    const editor = { render: () => [], invalidate: () => {} };
    let focused: any = editor;
    let mounted: any;
    const tui = {
      terminal: { rows: 30, columns: 100 },
      getFocusedComponent: () => focused,
      setFocus: vi.fn((component: any) => { focused = component; }),
      requestRender: vi.fn(),
    } as any;
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const setWidget = vi.fn((_key: string, content: any) => {
      mounted?.dispose?.();
      mounted = content?.(tui, theme);
    });
    const ctx = {
      ...makeHeadlessCtx(),
      hasUI: true,
      ui: {
        notify: vi.fn(),
        custom: vi.fn(),
        select: vi.fn(),
        setStatus: vi.fn(),
        setWidget,
      },
    } as any;

    await tools.get("Agent").execute(
      "active-agent",
      {
        prompt: "wait",
        description: "active child",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    const commandPromise = commands.get("agents").handler("", ctx);
    await vi.waitFor(() => expect(mounted?.handleInput).toBeTypeOf("function"));

    expect(tui.setFocus).toHaveBeenCalledWith(mounted);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(setWidget.mock.calls.every(([key]) => key === "agents")).toBe(true);

    await handlers.get("session_shutdown")?.({}, ctx);
    await commandPromise;
    expect(tui.setFocus).toHaveBeenLastCalledWith(editor);
  });

  it("notifies instead of throwing when /agents or pi-vim cannot restore focus", async () => {
    (globalThis as Record<PropertyKey, unknown>)[PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY] = undefined;
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools, commands, handlers } = makePi();
    subagentsExtension(pi);

    const tui = {
      terminal: { rows: 30, columns: 100 },
      setFocus: vi.fn(),
      requestRender: vi.fn(),
    } as any;
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const ctx = {
      ...makeHeadlessCtx(),
      mode: "tui",
      hasUI: true,
      ui: {
        notify: vi.fn(),
        custom: vi.fn(),
        select: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn((_key: string, content: any) => content?.(tui, theme)),
      },
    } as any;

    await handlers.get("session_start")?.({}, ctx);
    await tools.get("Agent").execute(
      "active-agent",
      {
        prompt: "wait",
        description: "active child",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx,
    );

    await expect(commands.get("agents").handler("", ctx)).resolves.toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Active subagent viewer is unavailable in this Pi version; update Pi to use /agents.",
      "warning",
    );

    const registry = (globalThis as Record<PropertyKey, any>)[PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY];
    expect(registry.handleNormalLeftArrow()).toBe(true);
    await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalledTimes(2));
    expect(tui.setFocus).not.toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("does not expose a max_turns parameter", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    expect(tools.get("Agent").parameters.properties).not.toHaveProperty("max_turns");
  });

  it.each(["max_turns", "maxTurns"])("rejects the removed %s parameter", async (field) => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockClear();

    const result = await tools.get("Agent").execute(
      "tool-call-limited",
      {
        prompt: "do work",
        description: "limited child",
        subagent_type: "general-purpose",
        [field]: 5,
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    expect(result.content[0].text).toBe("Turn limits are not supported by this vendored pi-subagents variant.");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it.each([
    ["steered", "Wrapped up (legacy turn limit)"],
    ["aborted", "Aborted (legacy turn limit)"],
  ])("renders historical %s results accurately", (status, expected) => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const agentTool = tools.get("Agent");
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const component = agentTool.renderResult(
      {
        content: [{ type: "text", text: "legacy result" }],
        details: {
          displayName: "Explore",
          description: "legacy",
          subagentType: "Explore",
          toolUses: 1,
          tokens: "",
          durationMs: 1000,
          status,
          turnCount: 5,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(component.render(200).join("\n")).toContain(expected);
  });

  it("persists and publishes foreground usage for cross-extension totals", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
      opts.onAssistantUsage?.({ input: 100, output: 25, cacheWrite: 5, cost: 0.42 });
      return {
        responseText: "done",
        session: { dispose: vi.fn() } as any,
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
