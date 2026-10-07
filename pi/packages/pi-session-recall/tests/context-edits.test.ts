import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildEditEvidence, querySession } from "../src/query";
import { formatSearchResult, searchSessions } from "../src/search";
import { editsOnBranch, parseTranscriptText, selectBranch, type BranchContextEdit } from "../src/transcript";
import { message, sessionJsonl, writeSession } from "./helpers";

const SECRET = "abcdefghijklmnopqrstuvwxyz123";

function edit(id: string, parentId: string, targetId: string, replacement: unknown, timestamp: string): unknown {
	return { type: "context_edit", id, parentId, timestamp, targetId, replacement };
}

/**
 * Main branch: u1 → a1 → a2 (tool call only) → t1 (bash result) → e1 → e2 → e3 → u3.
 * Alternate branch: a1 → alt → e4 (omits a1), older than the main leaf.
 */
function fixture(): string {
	return sessionJsonl({
		id: "edited-session",
		entries: [
			message("u1", null, "user", [{ type: "text", text: "Please run seq and explain." }], "2026-08-10T12:01:00.000Z"),
			message("a1", "u1", "assistant", [{ type: "text", text: "Original answer with lots of detail." }], "2026-08-10T12:02:00.000Z"),
			message("a2", "a1", "assistant", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "seq 1 300" } }], "2026-08-10T12:03:00.000Z"),
			{ ...(message("t1", "a2", "toolResult", [{ type: "text", text: "1\n2\n3\n...300" }], "2026-08-10T12:04:00.000Z") as object), message: { role: "toolResult", toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "1\n2\n3\n...300" }], timestamp: 0 } },
			edit("e1", "t1", "t1", { content: [{ type: "text", text: `[trimmed by CLM] ran seq: ok api_key=${SECRET}` }] }, "2026-08-10T12:05:00.000Z"),
			edit("e2", "e1", "a2", null, "2026-08-10T12:06:00.000Z"),
			edit("e3", "e2", "a1", { content: [{ type: "text", text: "short version" }, { type: "image", data: "x", mimeType: "image/png" }] }, "2026-08-10T12:07:00.000Z"),
			message("u3", "e3", "user", [{ type: "text", text: "Thanks, what next?" }], "2026-08-10T12:10:00.000Z"),
			message("alt", "a1", "assistant", [{ type: "text", text: "Alternate branch reply." }], "2026-08-10T12:02:30.000Z"),
			edit("e4", "alt", "a1", null, "2026-08-10T12:02:40.000Z"),
			{ type: "context_edit", id: "bad", parentId: "e4", timestamp: "2026-08-10T12:02:50.000Z", replacement: null },
		],
	});
}

describe("context edit parsing", () => {
	it("parses replace/omit edits with target roles, tool names, and masked clipped text", () => {
		const transcript = parseTranscriptText(fixture());
		expect(transcript.contextEdits.map((e) => [e.id, e.kind, e.targetRole, e.targetToolName])).toEqual([
			["e1", "replace", "toolResult", "bash"],
			["e2", "omit", "assistant", undefined],
			["e3", "replace", "assistant", undefined],
			["e4", "omit", "assistant", undefined],
		]);
		const e1 = transcript.contextEdits[0];
		expect(e1.replacementText).toContain("ran seq: ok");
		expect(e1.replacementText).toContain("[REDACTED:credential]");
		expect(e1.replacementText).not.toContain(SECRET);
		expect(e1.redactionCount).toBe(1);
		expect(transcript.contextEdits[2]).toMatchObject({ replacementText: "short version", nonTextBlocks: 1 });
		expect(transcript.malformedLines).toBe(1);
		// Edits never become visible messages.
		expect(transcript.visibleEntries.map((e) => e.id)).toEqual(["u1", "a1", "u3", "alt"]);
	});

	it("clips long replacement text", () => {
		const raw = sessionJsonl({
			entries: [
				message("a1", null, "assistant", [{ type: "text", text: "x" }]),
				edit("e1", "a1", "a1", { content: [{ type: "text", text: "y".repeat(5_000) }] }, "2026-08-10T12:05:00.000Z"),
			],
		});
		const text = parseTranscriptText(raw).contextEdits[0].replacementText ?? "";
		expect(text.length).toBeLessThan(1_100);
		expect(text).toContain("[edit text truncated]");
	});

	it("selects only edits on the branch and marks the latest edit per target", () => {
		const transcript = parseTranscriptText(fixture());
		const main = editsOnBranch(transcript, selectBranch(transcript));
		expect(main.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
		expect(main.every((e) => e.effective)).toBe(true);
		const alt = editsOnBranch(transcript, selectBranch(transcript, "alt"));
		expect(alt.map((e) => e.id)).toEqual(["e4"]);

		const twice = parseTranscriptText(sessionJsonl({
			entries: [
				message("a1", null, "assistant", [{ type: "text", text: "x" }]),
				edit("e1", "a1", "a1", { content: [{ type: "text", text: "first" }] }, "2026-08-10T12:05:00.000Z"),
				edit("e2", "e1", "a1", { content: [{ type: "text", text: "second" }] }, "2026-08-10T12:06:00.000Z"),
			],
		}));
		expect(editsOnBranch(twice, selectBranch(twice)).map((e) => [e.id, e.effective])).toEqual([["e1", false], ["e2", true]]);
	});
});

describe("session_search edit markers", () => {
	it("marks edited snippets, summarizes edits, and still searches original text only", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-edits-"));
		await writeSession(join(root, "project", "edited.jsonl"), fixture());

		const result = await searchSessions({ query: "Original answer", root });
		expect(result.matches).toHaveLength(1);
		const [match] = result.matches;
		expect(match.contextEdits).toEqual({ total: 4, replaced: 2, omitted: 2, onMessages: 3 });
		// Latest edit of a1 in file order is e4 (an omission on the alternate branch).
		expect(match.snippets[0].edit).toEqual({ kind: "omit", timestamp: "2026-08-10T12:02:40.000Z", count: 2, offBranch: true });
		const text = formatSearchResult("Original answer", result);
		expect(text).toContain("entry=a1 · removed from context 2026-08-10T12:02:40Z (2 edits, other branch)");
		expect(text).toContain("Context edits: 4 (2 replaced, 2 removed; 3 on user/assistant messages)");

		const unedited = await searchSessions({ query: "Thanks, what next", root });
		expect(unedited.matches[0].snippets[0].edit).toBeUndefined();

		const replacementOnly = await searchSessions({ query: "short version", root });
		expect(replacementOnly.matches).toHaveLength(0);
	});
});

describe("session_query edit evidence", () => {
	async function run(includeEdits: boolean, answer = "Answer [E-a1] [X-e1].") {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-edits-q-"));
		const path = join(root, "project", "edited.jsonl");
		await writeSession(path, fixture());
		let sent = "";
		const completeFn = vi.fn(async (_model: unknown, context: unknown) => {
			sent = JSON.stringify(context);
			return {
				role: "assistant",
				content: [{ type: "text", text: answer }],
				api: "test-api",
				provider: "test-provider",
				model: "test-model",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			} as any;
		});
		const result = await querySession({
			sessionPath: path,
			question: "What did the model trim from its context?",
			includeEdits,
			root,
			agentDir: join(root, "agent"),
			ctx: { model: { id: "test-model", provider: "test-provider", contextWindow: 32_000, maxTokens: 2_000 }, modelRegistry: { find: vi.fn() } } as any,
			completeFn,
		});
		return { result, sent };
	}

	it("annotates edited evidence and hints at includeEdits by default", async () => {
		const { result, sent } = await run(false, "Answer [E-a1].");
		expect(sent).toContain("Original answer with lots of detail.");
		expect(sent).toContain("[later edited in the model's context at 2026-08-10T12:07:00Z: replaced → \\\"short version\\\"]");
		expect(sent).not.toContain("[X-e");
		expect(sent).not.toContain("ran seq: ok");
		expect(result.contextEdits).toEqual({ total: 4, onBranch: 3, included: 0 });
		expect(result.warnings.join("\n")).toContain("pass includeEdits=true");
	});

	it("includes branch edit records, including tool-result replacement text, when requested", async () => {
		const { result, sent } = await run(true);
		expect(sent).toContain("[X-e1] 2026-08-10T12:05:00.000Z context edit: replaced tool result (bash) target=t1");
		expect(sent).toContain("ran seq: ok api_key=[REDACTED:credential]");
		expect(sent).not.toContain(SECRET);
		expect(sent).toContain("[X-e2] 2026-08-10T12:06:00.000Z context edit: removed assistant message (no visible text) target=a2");
		expect(sent).toContain("[1 non-text block(s) kept in replacement]");
		expect(sent).not.toContain("X-e4");
		expect(sent).not.toContain("Alternate branch reply");
		expect(result.contextEdits).toEqual({ total: 4, onBranch: 3, included: 3 });
		expect(result.warnings.join("\n")).not.toContain("unknown evidence IDs");
		expect(result.redactionCount).toBeGreaterThanOrEqual(1);
	});

	it("keeps the newest edit records within the budget", () => {
		const edits: BranchContextEdit[] = Array.from({ length: 20 }, (_, index) => ({
			id: `e${index}`,
			parentId: null,
			timestamp: `2026-08-10T12:${String(index).padStart(2, "0")}:00.000Z`,
			targetId: `t${index}`,
			kind: "replace",
			replacementText: "z".repeat(200),
			nonTextBlocks: 0,
			redactionCount: 0,
			targetRole: "toolResult",
			effective: true,
		}));
		const evidence = buildEditEvidence(edits, new Set(), 1_000);
		expect(evidence.omittedCount).toBeGreaterThan(0);
		expect(evidence.ids.at(-1)).toBe("X-e19");
		expect(evidence.text.startsWith(`[${evidence.omittedCount} less relevant or older context edit(s) omitted]`)).toBe(true);
	});

	it("keeps edit records relevant to the question ahead of newer ones", () => {
		const edits: BranchContextEdit[] = Array.from({ length: 20 }, (_, index) => ({
			id: `e${index}`,
			parentId: null,
			timestamp: `2026-08-10T12:${String(index).padStart(2, "0")}:00.000Z`,
			targetId: `t${index}`,
			kind: "replace",
			replacementText: index === 2 ? "[trimmed] full text of the arXiv paper" : "z".repeat(200),
			nonTextBlocks: 0,
			redactionCount: 0,
			targetRole: "toolResult",
			targetToolName: index === 2 ? "fetch_content" : "bash",
			effective: true,
		}));
		const evidence = buildEditEvidence(edits, new Set(), 1_000, "What note did it leave for the arXiv paper?");
		expect(evidence.ids).toContain("X-e2");
		expect(evidence.ids).toContain("X-e19");
		// Chronological output order.
		expect(evidence.ids.indexOf("X-e2")).toBe(0);
	});
});
