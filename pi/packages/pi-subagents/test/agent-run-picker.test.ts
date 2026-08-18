import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { AgentRunPicker, isActiveAgentRecord } from "../src/ui/agent-run-picker.js";

function record(id: string, status: AgentRecord["status"] = "running"): AgentRecord {
  return {
    id,
    type: id === "b" ? "Explore" : "general-purpose",
    description: `task ${id}`,
    status,
    toolUses: 0,
    startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    compactionCount: 0,
  };
}

function theme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function tui(rows = 30) {
  return {
    terminal: { rows, columns: 100 },
    requestRender: vi.fn(),
  } as any;
}

describe("isActiveAgentRecord", () => {
  it("only includes running and queued agents", () => {
    expect(isActiveAgentRecord(record("running", "running"))).toBe(true);
    expect(isActiveAgentRecord(record("queued", "queued"))).toBe(true);
    for (const status of ["completed", "error", "stopped", "steered", "aborted"] as const) {
      expect(isActiveAgentRecord(record(status, status))).toBe(false);
    }
  });
});

describe("AgentRunPicker", () => {
  it("frames the selector like a window", () => {
    const picker = new AgentRunPicker(
      tui(),
      { getAgents: () => [record("a")], getActivity: () => undefined },
      theme(),
      vi.fn(),
    );
    const lines = picker.render(60);

    expect(lines[0]).toMatch(/^╭.*╮$/);
    expect(lines.at(-1)).toMatch(/^╰.*╯$/);
    for (const line of lines.slice(1, -1)) expect(line).toMatch(/^│.*│$/);
    picker.dispose();
  });

  it("moves selection and returns the selected agent", () => {
    const agents = [record("a"), record("b"), record("c", "completed")];
    const done = vi.fn();
    const picker = new AgentRunPicker(
      tui(),
      { getAgents: () => agents, getActivity: () => undefined },
      theme(),
      done,
      "a",
    );

    picker.handleInput("\x1b[B");
    picker.handleInput("\r");

    expect(done).toHaveBeenCalledWith("b");
    picker.dispose();
  });

  it("preserves selection by id when the live list changes", () => {
    let agents = [record("a"), record("b")];
    const done = vi.fn();
    const picker = new AgentRunPicker(
      tui(),
      { getAgents: () => agents, getActivity: () => undefined },
      theme(),
      done,
      "b",
    );

    agents = [record("new"), ...agents];
    picker.handleInput("\r");

    expect(done).toHaveBeenCalledWith("b");
    picker.dispose();
  });

  it("returns to the prompt on right arrow", () => {
    const done = vi.fn();
    const picker = new AgentRunPicker(
      tui(),
      { getAgents: () => [record("a")], getActivity: () => undefined },
      theme(),
      done,
    );

    picker.handleInput("\x1b[C");

    expect(done).toHaveBeenCalledWith(undefined);
    picker.dispose();
  });

  it("renders an empty state and closes without a selection", () => {
    const done = vi.fn();
    const picker = new AgentRunPicker(
      tui(),
      { getAgents: () => [], getActivity: () => undefined },
      theme(),
      done,
    );

    expect(picker.render(60).join("\n")).toContain("No active subagents");
    picker.handleInput("\x1b");
    expect(done).toHaveBeenCalledWith(undefined);
    picker.dispose();
  });

  it("closes automatically when the final active agent disappears", () => {
    vi.useFakeTimers();
    let agents = [record("a")];
    const done = vi.fn();
    const picker = new AgentRunPicker(
      tui(),
      { getAgents: () => agents, getActivity: () => undefined },
      theme(),
      done,
    );

    agents = [];
    vi.advanceTimersByTime(100);

    expect(done).toHaveBeenCalledWith(undefined);
    picker.dispose();
    vi.useRealTimers();
  });

  it("keeps all rendered lines within the available width", () => {
    const agents = Array.from({ length: 20 }, (_, index) => ({
      ...record(String(index)),
      description: "a very long description ".repeat(10),
    }));
    const picker = new AgentRunPicker(
      tui(18),
      { getAgents: () => agents, getActivity: () => undefined },
      theme(),
      vi.fn(),
    );

    for (const width of [20, 40, 80]) {
      const lines = picker.render(width);
      expect(lines.length).toBeLessThanOrEqual(Math.floor(18 * 0.7));
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    picker.dispose();
  });
});
