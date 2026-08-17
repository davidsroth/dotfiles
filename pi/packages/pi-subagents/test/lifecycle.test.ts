import { describe, expect, it } from "vitest";
import { buildLifecycleEventData, buildPersistedRecordData } from "../src/index.js";
import type { AgentRecord } from "../src/types.js";

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "Explore",
    description: "inspect code",
    status: "completed",
    result: "done",
    toolUses: 3,
    startedAt: 100,
    completedAt: 250,
    lifetimeUsage: { input: 100, output: 40, cacheWrite: 10, cost: 0.1234 },
    compactionCount: 0,
    ...overrides,
  };
}

describe("subagent lifecycle records", () => {
  it("includes lifetime cost and the originating session in terminal event data", () => {
    expect(buildLifecycleEventData(record({ parentSessionId: "root-a" }))).toMatchObject({
      sessionId: "root-a",
      id: "agent-1",
      status: "completed",
      durationMs: 150,
      tokens: { input: 100, output: 40, total: 150 },
      cost: 0.1234,
    });
  });

  it("persists the full cumulative usage snapshot", () => {
    expect(buildPersistedRecordData(record()).usage).toEqual({
      input: 100,
      output: 40,
      cacheWrite: 10,
      cost: 0.1234,
    });
  });

  it("keeps tokens absent for failures before any model response while reporting zero cost", () => {
    expect(buildLifecycleEventData(record({
      status: "error",
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    }))).toMatchObject({ tokens: undefined, cost: 0 });
  });
});
