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
	const handlers = new Map<string, any>();
	const emit = vi.fn();
	const appendEntry = vi.fn();
	extension({
		events: { emit },
		appendEntry,
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: vi.fn(),
		registerTool: (tool: any) => tools.set(tool.name, tool),
	});
	return { tools, handlers, emit, appendEntry };
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

	it("keeps timeout distinct, resumes the same plan review, and clears it on feedback", async () => {
		dir = mkdtempSync(join(tmpdir(), "plan-resume-"));
		writeFileSync(join(dir, "PLAN.md"), "# Plan\n\nShip it.\n");
		const { tools, appendEntry } = captureTools(planExtension);
		vi.mocked(createReviewServer)
			.mockImplementationOnce(async (spec: any) => spec.onTimeout())
			.mockResolvedValueOnce({ action: "send-feedback", approved: false, feedback: "Add tests." });

		const timedOut = await tools.get("submit_plan").execute("plan-1", { filePath: "PLAN.md" }, undefined, undefined, interactiveCtx(dir));
		expect(timedOut.content[0].text).toMatch(/^TIMED OUT — plan review (plan-[^ ]+) is still pending/);
		const reviewId = timedOut.content[0].text.match(/plan-[^ ]+/)![0];

		const resumed = await tools.get("submit_plan").execute("plan-2", { filePath: "PLAN.md" }, undefined, undefined, interactiveCtx(dir));
		expect(resumed.content[0].text).toContain("Feedback on PLAN.md");
		expect(resumed.content[0].text).toContain("Add tests.");

		const pendingStates = appendEntry.mock.calls.map(([, data]) => data.pendingReview);
		expect(pendingStates[0]).toMatchObject({ reviewId, attempts: 1 });
		expect(pendingStates[1]).toMatchObject({ reviewId, attempts: 2 });
		expect(pendingStates.at(-1)).toBeNull();
	});

	it("restores a timed-out draft review and does not duplicate an active retry", async () => {
		const first = captureTools(draftExtension);
		vi.mocked(createReviewServer).mockImplementationOnce(async (spec: any) => spec.onTimeout());
		const timedOut = await first.tools.get("submit_draft").execute("draft-1", { text: "Ready." }, undefined, undefined, interactiveCtx(process.cwd()));
		const reviewId = timedOut.content[0].text.match(/draft-[^ ]+/)![0];
		const saved = first.appendEntry.mock.calls.at(-1)![1];

		const restored = captureTools(draftExtension);
		await restored.handlers.get("session_start")({}, {
			sessionManager: { getEntries: () => [{ type: "custom", customType: "draft-review", data: saved }] },
		});
		let resolveReview!: (value: any) => void;
		vi.mocked(createReviewServer).mockImplementationOnce(() => new Promise((resolve) => { resolveReview = resolve; }));

		const active = restored.tools.get("submit_draft").execute("draft-2", { text: "Ready.", reviewId }, undefined, undefined, interactiveCtx(process.cwd()));
		await vi.waitFor(() => expect(createReviewServer).toHaveBeenCalledTimes(2));
		const duplicate = await restored.tools.get("submit_draft").execute("draft-3", { text: "Ready.", reviewId }, undefined, undefined, interactiveCtx(process.cwd()));
		expect(duplicate.content[0].text).toContain("already open");
		expect(duplicate.content[0].text).toContain("No duplicate review was created");
		expect(createReviewServer).toHaveBeenCalledTimes(2);

		resolveReview({ action: "approve", text: "Ready." });
		await expect(active).resolves.toMatchObject({ content: [{ text: expect.stringMatching(/^APPROVE/) }] });
	});

	it("rejects an explicit resume when the input changed", async () => {
		const { tools } = captureTools(draftExtension);
		vi.mocked(createReviewServer).mockImplementationOnce(async (spec: any) => spec.onTimeout());
		const timedOut = await tools.get("submit_draft").execute("draft-1", { text: "Original" }, undefined, undefined, interactiveCtx(process.cwd()));
		const reviewId = timedOut.content[0].text.match(/draft-[^ ]+/)![0];

		const changed = await tools.get("submit_draft").execute("draft-2", { text: "Changed", reviewId }, undefined, undefined, interactiveCtx(process.cwd()));
		expect(changed.content[0].text).toContain("cannot resume because the text changed");
		expect(createReviewServer).toHaveBeenCalledTimes(1);
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
