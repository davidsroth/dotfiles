import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../extensions/_review/server", () => ({
	createReviewServer: vi.fn(),
}));
vi.mock("../extensions/_review/theme", () => ({
	loadTheme: () => ({ colors: {}, isLight: false }),
	buildPalette: () => ({}),
	rootVarsBlock: () => "",
}));
vi.mock("../extensions/_review/os", () => ({ pbcopy: vi.fn() }));

import planExtension from "../extensions/miniplan/index";
import draftExtension from "../extensions/draft/index";
import { createReviewServer } from "../extensions/_review/server";

function captureTools(extension: (pi: any) => void) {
	const tools = new Map<string, any>();
	const emit = vi.fn();
	extension({
		events: { emit },
		appendEntry: vi.fn(),
		on: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: (tool: any) => tools.set(tool.name, tool),
	});
	return { tools, emit };
}

const interactiveCtx = (cwd: string) => ({
	cwd,
	hasUI: true,
	ui: { notify: vi.fn() },
});

function expectBalancedBlocker(events: any[][], label: string) {
	expect(events).toHaveLength(2);
	const [, opened] = events[0]!;
	const [, closed] = events[1]!;
	expect(opened).toMatchObject({ active: true, label });
	expect(closed).toMatchObject({ active: false, label });
	expect(opened.id).toMatch(/^plan-review:/);
	expect(closed.id).toBe(opened.id);
}

describe("review tools report only browser decision waits to Herdr", () => {
	let dir: string | undefined;

	afterEach(() => {
		vi.mocked(createReviewServer).mockReset();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("wraps submit_plan review approval and failure in balanced events", async () => {
		dir = mkdtempSync(join(tmpdir(), "plan-herdr-"));
		writeFileSync(join(dir, "PLAN.md"), "# Plan\n\nShip it.\n");
		const { tools, emit } = captureTools(planExtension);
		vi.mocked(createReviewServer).mockResolvedValueOnce({ action: "approve", approved: true });

		const approved = await tools.get("submit_plan").execute("plan-1", { filePath: "PLAN.md" }, undefined, undefined, interactiveCtx(dir));
		expect(approved.content[0].text).toMatch(/Plan approved/);
		expectBalancedBlocker(emit.mock.calls, "Waiting for plan review");

		emit.mockClear();
		vi.mocked(createReviewServer).mockRejectedValueOnce(new Error("browser failed"));
		const failed = await tools.get("submit_plan").execute("plan-2", { filePath: "PLAN.md" }, undefined, undefined, interactiveCtx(dir));
		expect(failed.content[0].text).toMatch(/NOT approved/);
		expectBalancedBlocker(emit.mock.calls, "Waiting for plan review");
	});

	it("wraps submit_draft approval and emits nothing in headless mode", async () => {
		const { tools, emit } = captureTools(draftExtension);
		vi.mocked(createReviewServer).mockResolvedValueOnce({ action: "approve", text: "Ready." });

		const approved = await tools.get("submit_draft").execute("draft-1", { text: "Ready." }, undefined, undefined, interactiveCtx(process.cwd()));
		expect(approved.content[0].text).toMatch(/^APPROVE/);
		expectBalancedBlocker(emit.mock.calls, "Waiting for draft approval");

		emit.mockClear();
		const headless = await tools.get("submit_draft").execute("draft-2", { text: "Ready." }, undefined, undefined, {
			cwd: process.cwd(),
			hasUI: false,
			ui: { notify: vi.fn() },
		});
		expect(headless.content[0].text).toMatch(/auto-approved/);
		expect(emit).not.toHaveBeenCalled();
	});
});
