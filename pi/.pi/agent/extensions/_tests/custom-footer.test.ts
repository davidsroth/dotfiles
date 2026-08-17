import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { calculateBranchUsage, composeFooterLine, shortModelId } from "../custom-footer";

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

describe("shortModelId", () => {
	it("strips router-style prefixes", () => {
		expect(shortModelId("accounts/fireworks/routers/kimi-k3-fast")).toBe("kimi-k3-fast");
	});

	it("leaves plain ids untouched", () => {
		expect(shortModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
	});
});

describe("composeFooterLine", () => {
	const left = "notes ⎇ main ✓";

	it("pads between left and right when both fit", () => {
		const right = "ctx 12% · claude-sonnet-5";
		const line = composeFooterLine(left, right, 80);
		expect(visibleWidth(line)).toBe(80);
		expect(line.startsWith(left)).toBe(true);
		expect(line.endsWith(right)).toBe(true);
	});

	it("never exceeds terminal width when the right side alone is wider (2026-08-03 crash)", () => {
		// Crash reproduction: terminal 63, right side 76 wide (long model id), left truncated to 0.
		const right = "ctx 12% · ↑148k ↓32k ⊕3.4M · $2.90 · accounts/fireworks/routers/kimi-k3-fast";
		const line = composeFooterLine(left, right, 63);
		expect(visibleWidth(line)).toBeLessThanOrEqual(63);
	});

	it("clamps to width for tiny terminals and overwidth left", () => {
		const longLeft = "very-long-directory-name ⎇ feature/some-very-long-branch-name ✓ ↑3";
		const right = "ctx 99% · ↑9M ↓9M · $999.99 · some-model";
		for (const width of [20, 40, 59, 60, 61, 63, 80]) {
			expect(visibleWidth(composeFooterLine(longLeft, right, width))).toBeLessThanOrEqual(width);
		}
	});

	it("handles zero/negative budgets without throwing", () => {
		const right = "ctx 12% · ↑1k ↓1k · $1.00 · m";
		expect(visibleWidth(composeFooterLine(left, right, 60))).toBeLessThanOrEqual(60);
		expect(() => composeFooterLine("", right, 1)).not.toThrow();
	});

	it("truncateToWidth keeps ANSI-aware width within budget", () => {
		expect(visibleWidth(truncateToWidth("abcdef", 3))).toBeLessThanOrEqual(3);
	});
});

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
