import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function persistedRecord(id: string, result: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "custom",
    customType: "subagents:record",
    data: {
      id,
      type: "Explore",
      description: "persisted result",
      status: "completed",
      result,
      startedAt: Date.parse("2026-09-16T10:00:00.000Z"),
      completedAt: Date.parse("2026-09-16T10:01:00.000Z"),
      toolUses: 4,
      compactionCount: 1,
      outputFile: `/tmp/${id}.jsonl`,
      usage: { input: 100, output: 50, cacheWrite: 10, cost: 0.01 },
      ...overrides,
    },
  };
}

function makeHarness(branch: unknown[] = []) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => handlers.set(event, handler)),
    events: {
      emit: vi.fn((event: string, payload: unknown) => eventHandlers.get(event)?.(payload)),
      on: vi.fn((event: string, handler: any) => {
        eventHandlers.set(event, handler);
        return vi.fn(() => eventHandlers.delete(event));
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  const ctx = {
    hasUI: false,
    mode: "print",
    cwd: "/tmp",
    ui: { setStatus: vi.fn(), setWidget: vi.fn() },
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: {
      getSessionId: vi.fn(() => "contract-session"),
      getBranch: vi.fn(() => branch),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
  subagentsExtension(pi);

  const call = (name: string, params: Record<string, unknown>) => tools.get(name).execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    ctx,
  );
  const shutdown = () => handlers.get("session_shutdown")?.({}, ctx);
  return { call, ctx, shutdown };
}

afterEach(() => {
  delete (globalThis as any)[MANAGER_KEY];
  vi.restoreAllMocks();
});

describe("custom tool result contracts", () => {
  it("marks missing and expired targets as structured errors while live-only tools stay strict", async () => {
    const branch = [persistedRecord("expired-agent", "persisted output")];
    const harness = makeHarness(branch);

    const invalid = await harness.call("get_subagent_result", {});
    expect(invalid).toMatchObject({
      isError: true,
      details: { code: "INVALID_ARGUMENT", arguments: ["agent_id", "agent_ids"] },
    });

    const missing = await harness.call("get_subagent_result", { agent_id: "missing-agent" });
    expect(missing).toMatchObject({
      isError: true,
      details: { code: "AGENT_NOT_FOUND", agentId: "missing-agent" },
    });

    for (const [tool, params] of [
      ["aside_subagent", { agent_id: "expired-agent", message: "status?" }],
      ["steer_subagent", { agent_id: "expired-agent", message: "change direction" }],
      ["Agent", {
        prompt: "continue",
        description: "resume expired",
        subagent_type: "general-purpose",
        resume: "expired-agent",
      }],
    ] as const) {
      const result = await harness.call(tool, params);
      expect(result).toMatchObject({
        isError: true,
        details: { code: "AGENT_NOT_FOUND", agentId: "expired-agent" },
      });
    }

    await harness.shutdown();
  });

  it("recovers persisted terminal results and exposes completion age and full-output instructions", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-16T10:06:00.000Z"));
    const harness = makeHarness([persistedRecord("persisted-agent", "complete persisted result")]);

    const summary = await harness.call("get_subagent_result", { agent_id: "persisted-agent" });
    expect(summary.isError).not.toBe(true);
    expect(summary.details).toMatchObject({
      agentId: "persisted-agent",
      resultMode: "summary",
      recoveredFromPersistence: true,
      outputFile: "/tmp/persisted-agent.jsonl",
    });
    expect(summary.content[0].text).toContain("complete persisted result");
    expect(summary.content[0].text).toContain("Recovered from persisted session record");
    expect(summary.content[0].text).toContain("Completed: 2026-09-16T10:01:00.000Z (5m0s ago)");
    expect(summary.content[0].text).toContain('result_mode "full"');
    expect(summary.content[0].text).toContain("Full transcript: /tmp/persisted-agent.jsonl");

    const full = await harness.call("get_subagent_result", {
      agent_id: "persisted-agent",
      result_mode: "full",
    });
    expect(full.details).toMatchObject({ resultMode: "full", recoveredFromPersistence: true });
    expect(full.content[0].text).toContain("complete persisted result");
    expect(full.content[0].text).not.toContain("To retrieve the complete result");

    await harness.shutdown();
  });

  it("bounds default summaries, marks incompleteness, and never cuts large JSON", async () => {
    const longText = "word ".repeat(5_000).trim();
    const longJson = JSON.stringify({ items: Array.from({ length: 2_000 }, (_, index) => ({ index, value: `value-${index}` })) });
    const harness = makeHarness([
      persistedRecord("long-text", longText),
      persistedRecord("long-json", longJson),
    ]);

    const textSummary = await harness.call("get_subagent_result", { agent_id: "long-text" });
    expect(Buffer.byteLength(textSummary.content[0].text, "utf8")).toBeLessThan(10 * 1024);
    expect(textSummary.content[0].text).toContain("Summary preview incomplete:");
    expect(textSummary.content[0].text).toContain('result_mode "full"');

    const jsonSummary = await harness.call("get_subagent_result", { agent_id: "long-json" });
    expect(Buffer.byteLength(jsonSummary.content[0].text, "utf8")).toBeLessThan(10 * 1024);
    expect(jsonSummary.content[0].text).toContain("Full result omitted from summary: valid JSON object with 1 key");
    expect(jsonSummary.content[0].text).not.toContain('{"items"');

    const full = await harness.call("get_subagent_result", { agent_id: "long-json", result_mode: "full" });
    expect(full.content[0].text).toContain(longJson);
    expect(Buffer.byteLength(full.content[0].text, "utf8")).toBeGreaterThan(10 * 1024);

    await harness.shutdown();
  });
});
