import { describe, expect, it } from "vitest";
import { inspectApprovalBatch } from "../extensions/_review/batch";

function assistantBatch(calls: Array<{ id: string; name: string }>): unknown[] {
	return [{
		type: "message",
		message: {
			role: "assistant",
			stopReason: "toolUse",
			content: calls.map((call) => ({ type: "toolCall", ...call, arguments: {} })),
		},
	}];
}

describe("approval batch inspection", () => {
	it("blocks the gate and every sibling call from the same assistant message", () => {
		const branch = assistantBatch([
			{ id: "gate", name: "submit_plan" },
			{ id: "mutation", name: "edit" },
		]);

		for (const id of ["gate", "mutation"]) {
			expect(inspectApprovalBatch(branch, id, "submit_plan")).toEqual({
				blocked: true,
				gateNames: ["submit_plan"],
				toolNames: ["submit_plan", "edit"],
				reason: expect.stringContaining("retry submit_plan alone"),
			});
		}
	});

	it("allows an approval gate when it is the only call", () => {
		expect(inspectApprovalBatch(
			assistantBatch([{ id: "gate", name: "submit_draft" }]),
			"gate",
			"submit_draft",
		)).toEqual({
			blocked: false,
			gateNames: ["submit_draft"],
			toolNames: ["submit_draft"],
		});
	});

	it("allows unrelated batches and ignores older unmatched messages", () => {
		const branch = [
			...assistantBatch([{ id: "old", name: "submit_plan" }, { id: "old-edit", name: "edit" }]),
			...assistantBatch([{ id: "read", name: "read" }, { id: "grep", name: "grep" }]),
		];
		expect(inspectApprovalBatch(branch, "read", "submit_plan")).toEqual({
			blocked: false,
			gateNames: [],
			toolNames: ["read", "grep"],
		});
	});
});
