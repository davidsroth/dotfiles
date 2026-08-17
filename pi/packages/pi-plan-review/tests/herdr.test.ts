import { describe, expect, it, vi } from "vitest";
import { HERDR_BLOCKED_EVENT, waitWithHerdrBlocked } from "../extensions/_review/herdr";

describe("Herdr browser-review state", () => {
	it("balances plan/draft review state after approval with one stable blocker ID", async () => {
		const emit = vi.fn();
		const result = await waitWithHerdrBlocked(
			{ events: { emit } } as any,
			"Waiting for plan review",
			async () => "approved",
		);

		expect(result).toBe("approved");
		expect(emit.mock.calls).toHaveLength(2);
		const [, opened] = emit.mock.calls[0]!;
		const [, closed] = emit.mock.calls[1]!;
		expect(opened).toMatchObject({ active: true, label: "Waiting for plan review" });
		expect(closed).toMatchObject({ active: false, label: "Waiting for plan review" });
		expect(opened.id).toMatch(/^plan-review:/);
		expect(closed.id).toBe(opened.id);
	});

	it("keeps overlapping waits independently identifiable through out-of-order cleanup", async () => {
		const emit = vi.fn();
		let finishFirst!: () => void;
		let finishSecond!: () => void;
		const first = waitWithHerdrBlocked(
			{ events: { emit } } as any,
			"First review",
			() => new Promise<void>((resolve) => { finishFirst = resolve; }),
		);
		const second = waitWithHerdrBlocked(
			{ events: { emit } } as any,
			"Second review",
			() => new Promise<void>((resolve) => { finishSecond = resolve; }),
		);

		const firstId = emit.mock.calls[0]![1].id;
		const secondId = emit.mock.calls[1]![1].id;
		expect(firstId).not.toBe(secondId);
		finishSecond();
		await second;
		finishFirst();
		await first;
		expect(emit.mock.calls.slice(2).map(([, payload]) => payload)).toEqual([
			{ id: secondId, active: false, label: "Second review" },
			{ id: firstId, active: false, label: "First review" },
		]);
	});

	it("balances state when review is cancelled, times out, or errors", async () => {
		const emit = vi.fn();
		await expect(waitWithHerdrBlocked(
			{ events: { emit } } as any,
			"Waiting for draft approval",
			async () => { throw new Error("browser unavailable"); },
		)).rejects.toThrow("browser unavailable");

		const payloads = emit.mock.calls.map(([, payload]) => payload);
		expect(payloads[0]).toMatchObject({ active: true, label: "Waiting for draft approval" });
		expect(payloads[1]).toMatchObject({ active: false, label: "Waiting for draft approval" });
		expect(payloads[1].id).toBe(payloads[0].id);
	});

	it("does not let optional Herdr listener failures affect review", async () => {
		const pi = { events: { emit: () => { throw new Error("no Herdr"); } } } as any;
		await expect(waitWithHerdrBlocked(pi, "Waiting for plan review", async () => "result"))
			.resolves.toBe("result");
	});
});
