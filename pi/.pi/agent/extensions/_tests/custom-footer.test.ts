import { describe, expect, it } from "vitest";
import { calculateBranchUsage } from "../custom-footer";

function assistant(input: number, output: number, cost: number, cacheRead = 0, cacheWrite = 0) {
	return {
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite,
				cost: { total: cost },
			},
		},
	};
}

function subagent(id: string, cost: number) {
	return {
		type: "custom",
		customType: "subagents:record",
		data: { id, usage: { input: 0, output: 0, cacheWrite: 0, cost } },
	};
}

describe("calculateBranchUsage", () => {
	it("adds persisted subagent costs to top-level assistant cost", () => {
		const usage = calculateBranchUsage([
			assistant(100, 20, 1.25, 40, 5),
			subagent("agent-1", 0.2),
			subagent("agent-2", 0.1),
		]);

		expect(usage).toEqual({
			input: 100,
			output: 20,
			cacheRead: 40,
			cacheWrite: 5,
			cost: 1.55,
		});
	});

	it("uses only the latest cumulative record for a resumed agent", () => {
		const usage = calculateBranchUsage([
			subagent("agent-1", 0.2),
			subagent("agent-2", 0.1),
			subagent("agent-1", 0.35),
		]);

		expect(usage.cost).toBeCloseTo(0.45);
	});

	it("overrides persisted costs with cumulative live usage without double-counting", () => {
		const live = new Map([
			["agent-1", 0.5],
			["agent-3", 0.25],
		]);
		const usage = calculateBranchUsage([
			assistant(10, 5, 1.25),
			subagent("agent-1", 0.2),
			subagent("agent-2", 0.1),
		], live);

		expect(usage.cost).toBeCloseTo(2.1);
	});

	it("ignores unrelated and malformed custom entries", () => {
		const usage = calculateBranchUsage([
			{ type: "custom", customType: "other", data: { id: "x", cost: 10 } },
			{ type: "custom", customType: "subagents:record", data: { id: "x", usage: { cost: -1 } } },
			{ type: "custom", customType: "subagents:record", data: { usage: { cost: 2 } } },
		]);

		expect(usage.cost).toBe(0);
	});
});
