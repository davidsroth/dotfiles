import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AgentWidget, formatMs, formatSessionTokens, renderAgentRunLine } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  it("returns plain text with percent annotation", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (50%)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (70%)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (84%)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (85%)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (99%)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (↻1)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (↻3)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (45% · ↻2)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (88% · ↻4)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (45%)");
  });
});

describe("renderAgentRunLine", () => {
  it("never exceeds the requested width when statistics are wider than the row", () => {
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    const line = renderAgentRunLine({
      id: "agent",
      type: "general-purpose",
      description: "very long task description",
      status: "completed",
      toolUses: 123456,
      startedAt: 0,
      completedAt: 9_999_999,
      lifetimeUsage: { input: 10_000_000, output: 10_000_000, cacheWrite: 0, cost: 1234.56 },
      compactionCount: 0,
    }, undefined, theme, 12);

    expect(visibleWidth(line)).toBeLessThanOrEqual(12);
  });
});

describe("AgentWidget focused mode", () => {
  it("notifies and cancels without changing focus when prior focus is unavailable", async () => {
    const setFocus = vi.fn();
    const notify = vi.fn();
    const tui = {
      terminal: { rows: 30, columns: 100 },
      setFocus,
      requestRender: vi.fn(),
    } as any;
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    const setWidget = vi.fn((_key: string, content: any) => {
      content?.(tui, theme);
    });
    const widget = new AgentWidget({ listAgents: () => [] } as any, new Map());
    widget.setUICtx({ setWidget, setStatus: vi.fn(), notify });

    await expect(widget.withFocusedWidget(async (present) => present((_tui, _theme, _done) => ({
      render: () => [],
      invalidate: () => {},
    })))).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledWith(
      "Active subagent viewer is unavailable in this Pi version; update Pi to use /agents.",
      "warning",
    );
    expect(setFocus).not.toHaveBeenCalled();
    widget.dispose();
  });

  it("mounts the interactive component in the agents widget and restores editor focus", async () => {
    const editor = { render: () => [], invalidate: () => {} };
    const setFocus = vi.fn();
    const tui = {
      terminal: { rows: 30, columns: 100 },
      getFocusedComponent: () => editor,
      setFocus,
      requestRender: vi.fn(),
    } as any;
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    let mounted: any;
    const setWidget = vi.fn((_key: string, content: any) => {
      mounted?.dispose?.();
      mounted = content?.(tui, theme);
    });
    const widget = new AgentWidget({
      listAgents: () => [{
        id: "active",
        type: "general-purpose",
        description: "active",
        status: "running",
        toolUses: 0,
        startedAt: Date.now(),
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
      }],
    } as any, new Map());
    widget.setUICtx({ setWidget, setStatus: vi.fn() });

    let finishFirst!: (value: string) => void;
    let finishSecond!: (value: string) => void;
    const first = { render: () => ["picker"], invalidate: () => {}, dispose: vi.fn() };
    const second = { render: () => ["monitor"], invalidate: () => {}, dispose: vi.fn() };
    const resultPromise = widget.withFocusedWidget(async (present) => {
      const picked = await present<string>((_tui, _theme, done) => {
        finishFirst = done;
        return first;
      });
      const watched = await present<string>((_tui, _theme, done) => {
        finishSecond = done;
        return second;
      });
      return `${picked}:${watched}`;
    });

    expect(mounted).toBe(first);
    expect(setFocus).toHaveBeenCalledWith(first);
    finishFirst("selected");
    await vi.waitFor(() => expect(mounted).toBe(second));
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(setFocus).toHaveBeenCalledWith(second);
    finishSecond("closed");
    await expect(resultPromise).resolves.toBe("selected:closed");

    expect(second.dispose).toHaveBeenCalledOnce();
    expect(setFocus).toHaveBeenLastCalledWith(editor);
    expect(setWidget.mock.calls.every(([key]) => key === "agents")).toBe(true);
    widget.dispose();
  });
});

describe("formatMs", () => {
  it("formats sub-minute durations as whole seconds", () => {
    expect(formatMs(0)).toBe("0s");
    expect(formatMs(999)).toBe("0s");
    expect(formatMs(42_500)).toBe("42s");
  });

  it("formats minutes and hours compactly", () => {
    expect(formatMs(5 * 60_000 + 30_000)).toBe("5m30s");
    expect(formatMs(60 * 60_000 + 2 * 60_000 + 3_000)).toBe("1h2m3s");
  });

  it("clamps negative durations to zero", () => {
    expect(formatMs(-1_000)).toBe("0s");
  });
});
