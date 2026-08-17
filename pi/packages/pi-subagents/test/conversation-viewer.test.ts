import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";

// ── Mock wrapTextWithAnsi ──────────────────────────────────────────────
// We need to control what wrapTextWithAnsi returns to simulate the
// upstream bug (returning lines wider than requested width).
// vi.mock is hoisted and intercepts before conversation-viewer.ts binds
// its import.

let wrapOverride: ((text: string, width: number) => string[]) | null = null;

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return {
    ...original,
    wrapTextWithAnsi: (...args: [string, number]) => {
      if (wrapOverride) return wrapOverride(...args);
      return original.wrapTextWithAnsi(...args);
    },
  };
});

// Must import AFTER vi.mock declaration (vitest hoists vi.mock but the
// dynamic import of the test subject must happen after)
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { ConversationViewer } = await import("../src/ui/conversation-viewer.js");

// ── Helpers ────────────────────────────────────────────────────────────

function mockTui(rows = 40, columns = 80) {
  return {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  } as any;
}

function mockSession(messages: any[] = []) {
  return {
    messages,
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}

function mockRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    ...overrides,
  } as AgentRecord;
}

function ansiTheme() {
  return {
    fg: (_color: string, text: string) => `\x1b[38;5;240m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as any;
}

function assertAllLinesFit(lines: string[], width: number) {
  for (let i = 0; i < lines.length; i++) {
    const vw = visibleWidth(lines[i]);
    expect(vw, `line ${i} exceeds width (${vw} > ${width}): ${JSON.stringify(lines[i])}`).toBeLessThanOrEqual(width);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  wrapOverride = null;
});

describe("ConversationViewer", () => {
  describe("render width safety", () => {
    const widths = [40, 80, 120, 216];

    it("no line exceeds width with empty messages", () => {
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession([]), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with plain text messages", () => {
      const messages = [
        { role: "user", content: "Hello, how are you?" },
        { role: "assistant", content: [{ type: "text", text: "I am fine, thank you for asking." }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width when text is longer than viewport", () => {
      const longLine = "A".repeat(500);
      const messages = [
        { role: "user", content: longLine },
        { role: "assistant", content: [{ type: "text", text: longLine }] },
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: longLine }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with embedded ANSI escape codes in content", () => {
      const ansiText = `\x1b[1mBold heading\x1b[22m and \x1b[31mred text\x1b[0m ${"X".repeat(300)}`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: ansiText }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with long URLs", () => {
      const url = "https://example.com/" + "a/b/c/d/e/".repeat(30) + "?q=" + "x".repeat(100);
      const messages = [
        { role: "assistant", content: [{ type: "text", text: `Check this link: ${url}` }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with wide table-like content", () => {
      const header = "| " + Array.from({ length: 20 }, (_, i) => `Column${i}`).join(" | ") + " |";
      const dataRow = "| " + Array.from({ length: 20 }, () => "value123").join(" | ") + " |";
      const table = [header, dataRow, dataRow, dataRow].join("\n");
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: table }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with bashExecution messages", () => {
      const messages = [
        {
          role: "bashExecution", command: "cat " + "/very/long/path/".repeat(20) + "file.txt",
          output: "O".repeat(600),
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with running activity indicator", () => {
      const activity = {
        activeTools: new Map([["read", "file.ts"], ["grep", "pattern"]]),
        toolUses: 5, tokens: "10k", responseText: "R".repeat(400),
        session: { getSessionStats: () => ({ tokens: { total: 50000 } }) },
      };
      const messages = [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord({ status: "running" }), activity as any, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with tool calls", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "toolCall", toolUseId: "t1", name: "very_long_tool_name_" + "x".repeat(200), input: {} },
          ],
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width at narrow terminal", () => {
      const messages = [
        { role: "user", content: "Hello world, this is a normal sentence." },
        { role: "assistant", content: [{ type: "text", text: "Sure, here's the answer." }] },
      ];
      for (const w of [8, 10, 15, 20]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with mixed ANSI + unicode content", () => {
      const text = `\x1b[32m✓\x1b[0m Test passed — 日本語テスト ${"あ".repeat(50)} \x1b[33m⚠\x1b[0m`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });

  describe("safety net against upstream wrapTextWithAnsi bugs", () => {
    // These tests call buildContentLines() directly (via the private method)
    // because render() has its own truncation via row(). The safety net in
    // buildContentLines is what prevents the TUI crash — it must clamp
    // independently of render().

    /** Call the private buildContentLines method directly. */
    function callBuildContentLines(viewer: InstanceType<typeof ConversationViewer>, width: number): string[] {
      return (viewer as any).buildContentLines(width);
    }

    it("mock is intercepting wrapTextWithAnsi", async () => {
      const { wrapTextWithAnsi } = await import("@earendil-works/pi-tui");
      wrapOverride = () => ["MOCK_SENTINEL"];
      expect(wrapTextWithAnsi("anything", 10)).toEqual(["MOCK_SENTINEL"]);
      wrapOverride = null;
    });

    it("clamps overwidth lines from toolResult content", () => {
      const w = 80;
      wrapOverride = () => ["X".repeat(w + 50)];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from user message content", () => {
      const w = 80;
      wrapOverride = () => ["Y".repeat(w + 100)];

      const messages = [{ role: "user", content: "hello" }];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from assistant message content", () => {
      const w = 80;
      wrapOverride = () => ["Z".repeat(w + 100)];

      const messages = [
        { role: "assistant", content: [{ type: "text", text: "response" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from bashExecution output", () => {
      const w = 80;
      wrapOverride = () => ["B".repeat(w + 100)];

      const messages = [
        {
          role: "bashExecution", command: "ls", output: "out",
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines that also contain ANSI codes", () => {
      const w = 80;
      wrapOverride = () => [`\x1b[1m\x1b[31m${"W".repeat(w + 30)}\x1b[0m`];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });
  });
});

describe("ConversationViewer monitor controls", () => {
  it("moves between live agent records and swaps session subscriptions", () => {
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    const firstSession = {
      ...mockSession([{ role: "user", content: "first" }]),
      subscribe: vi.fn(() => firstUnsubscribe),
    };
    const secondSession = {
      ...mockSession([{ role: "user", content: "second" }]),
      subscribe: vi.fn(() => secondUnsubscribe),
    };
    const first = mockRecord({ id: "first", session: firstSession });
    const second = mockRecord({ id: "second", session: secondSession });
    const viewer = new ConversationViewer(
      mockTui(),
      firstSession,
      first,
      undefined,
      ansiTheme(),
      vi.fn(),
      { getAgents: () => [first, second], getActivity: () => undefined },
    );

    viewer.handleInput("\x1b[C");
    const rendered = viewer.render(80).join("\n");

    expect(firstUnsubscribe).toHaveBeenCalledOnce();
    expect(secondSession.subscribe).toHaveBeenCalledOnce();
    expect(rendered).toContain("2/2");
    expect(rendered).toContain("second");
    viewer.dispose();
    expect(secondUnsubscribe).toHaveBeenCalledOnce();
  });

  it("composes and sends a steering message inline", async () => {
    const onSteer = vi.fn(async () => ({ ok: true, message: "Steering message sent." }));
    const record = mockRecord({ id: "running", lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 } });
    const tui = mockTui();
    const viewer = new ConversationViewer(
      tui,
      mockSession(),
      record,
      undefined,
      ansiTheme(),
      vi.fn(),
      { onSteer },
    );
    viewer.focused = true;

    viewer.handleInput("s");
    expect((viewer as any).steerInput.focused).toBe(true);
    const composeView = viewer.render(100).join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\x1b_[^\x07]*\x07/g, "");
    expect(composeView).toContain("steer >");
    expect(composeView).not.toContain("› >");
    for (const char of "focus tests") viewer.handleInput(char);
    viewer.handleInput("\r");

    await vi.waitFor(() => expect(onSteer).toHaveBeenCalledWith(record, "focus tests"));
    expect(viewer.render(100).join("\n")).toContain("Steering message sent.");
    expect((viewer as any).composingSteer).toBe(false);
    viewer.dispose();
  });

  it("does not enter steering mode for a completed agent", () => {
    const onSteer = vi.fn();
    const record = mockRecord({
      status: "completed",
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    });
    const viewer = new ConversationViewer(
      mockTui(), mockSession(), record, undefined, ansiTheme(), vi.fn(), { onSteer },
    );

    viewer.handleInput("s");

    expect((viewer as any).composingSteer).toBe(false);
    expect(viewer.render(100).join("\n")).toContain("Cannot steer a completed agent.");
    expect(onSteer).not.toHaveBeenCalled();
    viewer.dispose();
  });

  it("attaches when an in-place queued record receives its session", () => {
    const record = mockRecord({ id: "queued", status: "queued", session: undefined });
    const session = mockSession([{ role: "user", content: "started" }]);
    const viewer = new ConversationViewer(
      mockTui(),
      undefined,
      record,
      undefined,
      ansiTheme(),
      vi.fn(),
      { getAgents: () => [record], getActivity: () => undefined },
    );

    record.status = "running";
    record.session = session;
    const rendered = viewer.render(80).join("\n");

    expect(session.subscribe).toHaveBeenCalledOnce();
    expect(rendered).toContain("started");
    viewer.dispose();
  });

  it("detaches from a session when the live record list becomes empty", () => {
    const unsubscribe = vi.fn();
    const session = { ...mockSession(), subscribe: vi.fn(() => unsubscribe) };
    const record = mockRecord({ id: "removed", session });
    let agents = [record];
    const viewer = new ConversationViewer(
      mockTui(),
      session,
      record,
      undefined,
      ansiTheme(),
      vi.fn(),
      { getAgents: () => agents, getActivity: () => undefined },
    );

    agents = [];
    viewer.render(80);

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect((viewer as any).session).toBeUndefined();
    viewer.dispose();
  });

  it("falls back to another active agent when the selected one completes", () => {
    const firstSession = mockSession([{ role: "user", content: "first" }]);
    const secondSession = mockSession([{ role: "user", content: "second" }]);
    const first = mockRecord({ id: "first", session: firstSession });
    const second = mockRecord({ id: "second", session: secondSession });
    let agents = [first, second];
    const viewer = new ConversationViewer(
      mockTui(),
      firstSession,
      first,
      undefined,
      ansiTheme(),
      vi.fn(),
      { getAgents: () => agents, getActivity: () => undefined },
    );

    first.status = "completed";
    agents = [second];
    const rendered = viewer.render(80).join("\n");

    expect(rendered).toContain("1/1");
    expect(rendered).toContain("second");
    expect(secondSession.subscribe).toHaveBeenCalledOnce();
    viewer.dispose();
  });

  it("closes when the final active agent completes", () => {
    vi.useFakeTimers();
    const session = mockSession();
    const record = mockRecord({ id: "only", session });
    let agents = [record];
    const done = vi.fn();
    const viewer = new ConversationViewer(
      mockTui(),
      session,
      record,
      undefined,
      ansiTheme(),
      done,
      { getAgents: () => agents, getActivity: () => undefined },
    );

    record.status = "completed";
    agents = [];
    vi.advanceTimersByTime(100);

    expect(done).toHaveBeenCalledWith(undefined);
    viewer.dispose();
    vi.useRealTimers();
  });

  it("preserves the steering draft when delivery fails", async () => {
    const onSteer = vi.fn(async () => ({ ok: false, message: "Agent is no longer running." }));
    const record = mockRecord({
      status: "running",
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    });
    const viewer = new ConversationViewer(
      mockTui(), mockSession(), record, undefined, ansiTheme(), vi.fn(), { onSteer },
    );
    viewer.focused = true;

    viewer.handleInput("s");
    for (const char of "keep this") viewer.handleInput(char);
    viewer.handleInput("\r");

    await vi.waitFor(() => expect(onSteer).toHaveBeenCalled());
    expect((viewer as any).composingSteer).toBe(true);
    expect((viewer as any).steerInput.getValue()).toBe("keep this");
    expect(viewer.render(100).join("\n")).toContain("Agent is no longer running.");
    viewer.dispose();
  });
});
