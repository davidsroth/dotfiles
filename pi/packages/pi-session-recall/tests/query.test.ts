import { appendFile, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { boundAnswer, buildEvidenceWindow, formatQueryResult, querySession } from "../src/query";
import { readTranscript, type VisibleEntry } from "../src/transcript";
import { message, sessionJsonl, writeSession } from "./helpers";

const model = {
	id: "test-model",
	name: "Test Model",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 2_000,
} as any;

const usage = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantResponse(text = "Facade answer [E-u1]."): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function fakeContext(activeModel = model): any {
	return {
		model: activeModel,
		modelRegistry: {
			find: vi.fn(),
			complete: vi.fn().mockResolvedValue(assistantResponse()),
		},
	};
}

describe("evidence window", () => {
	it("uses stable entry-derived IDs, relevance, neighbors, and bookends", () => {
		const entries: VisibleEntry[] = Array.from({ length: 8 }, (_, index) => ({
			id: `id${index}`,
			parentId: index ? `id${index - 1}` : null,
			timestamp: `2026-08-10T12:0${index}:00.000Z`,
			role: index % 2 ? "assistant" : "user",
			text: index === 4 ? "The unusual-widget decision is here" : `ordinary ${index}`,
		}));
		const window = buildEvidenceWindow(entries, "What was the unusual-widget decision?", 1_000);
		expect(window.items.map((item) => item.id)).toContain("E-id4");
		expect(window.items.map((item) => item.id)).toContain("E-id3");
		expect(window.items.map((item) => item.id)).toContain("E-id5");
		expect(window.items[0].id).toBe("E-id0");
		expect(window.items.at(-1)?.id).toBe("E-id7");
	});

	it("prioritizes relevant entries before oversized bookends", () => {
		const entries: VisibleEntry[] = [
			{ id: "first", parentId: null, timestamp: "2026-08-10T12:00:00Z", role: "user", text: "x".repeat(2_000) },
			{ id: "relevant", parentId: "first", timestamp: "2026-08-10T12:01:00Z", role: "assistant", text: "widget-decision was option B" },
			{ id: "last", parentId: "relevant", timestamp: "2026-08-10T12:02:00Z", role: "user", text: "y".repeat(2_000) },
		];
		const window = buildEvidenceWindow(entries, "widget-decision", 500);
		expect(window.items.map((item) => item.id)).toContain("E-relevant");
	});
});

describe("session query", () => {
	it("sends only redacted visible branch evidence with no tools and reports provenance", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-query-"));
		const agentDir = join(root, "agent");
		const path = join(root, "selected.jsonl");
		await writeSession(
			path,
			sessionJsonl({
				id: "selected-session",
				entries: [
					message("root", null, "user", [{ type: "text", text: "Setup" }], "2026-08-10T12:00:00.000Z"),
					message("u1", "root", "user", [{ type: "text", text: "Decision api_key=abcdefghijklmnopqrstuv" }], "2026-08-10T12:01:00.000Z"),
					message("a1", "u1", "assistant", [
						{ type: "thinking", thinking: "never send this thought" },
						{ type: "toolCall", name: "bash", arguments: { secret: "never send this argument" } },
						{ type: "text", text: "We chose option B." },
					]),
					message("t1", "a1", "toolResult", [{ type: "text", text: "never send this result" }], "2026-08-10T12:03:00.000Z"),
					message("other", "root", "assistant", [{ type: "text", text: "unrelated alternate branch" }], "2026-08-10T12:04:00.000Z"),
				],
			}),
		);
		let nestedContext: any;
		const completeFn = vi.fn(async (_model, context) => {
			nestedContext = context;
			return assistantResponse("The session reports choosing B [E-a1].");
		}) as any;

		const result = await querySession({
			sessionPath: path,
			question: "What was decided?",
			entryId: "u1",
			root,
			agentDir,
			ctx: fakeContext(),
			completeFn,
		});
		const sent = JSON.stringify(nestedContext);
		expect(sent).toContain("[REDACTED:credential]");
		expect(sent).not.toContain("abcdefghijklmnopqrstuv");
		expect(sent).not.toContain("never send this");
		expect(sent).not.toContain("unrelated alternate branch");
		expect(sent).toContain("We chose option B");
		expect(nestedContext.tools).toEqual([]);
		expect(result).toMatchObject({
			sessionId: "selected-session",
			path: await realpath(path),
			branchAnchor: "t1",
			redactionCount: 1,
			model: { provider: "test-provider", id: "test-model" },
			usage,
		});
		expect(result.warnings).toEqual(["Historical assistant-reported mutations require live verification."]);
		expect(formatQueryResult("What was decided?", result)).toContain("SHA-256:");
	});

	it("redacts a complete entry before clipping nested-model evidence", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-query-pem-"));
		const path = join(root, "selected.jsonl");
		const keyBody = "Q".repeat(7_000);
		await writeSession(path, sessionJsonl({
			entries: [message("u1", null, "user", [{
				type: "text",
				text: `QueryPemNeedle\n-----BEGIN PRIVATE KEY-----\n${keyBody}\n-----END PRIVATE KEY-----`,
			}])],
		}));
		let nestedContext: any;
		const completeFn = vi.fn(async (_model, context) => {
			nestedContext = context;
			return assistantResponse("The key was redacted [E-u1].");
		}) as any;

		await querySession({
			sessionPath: path,
			question: "What did the entry contain?",
			root,
			agentDir: join(root, "agent"),
			ctx: fakeContext(),
			completeFn,
		});
		const sent = JSON.stringify(nestedContext);
		expect(sent).toContain("[REDACTED:private-key]");
		expect(sent).not.toContain("Q".repeat(40));
	});

	it("uses the public modelRegistry.complete facade with no tools", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-facade-"));
		const path = join(root, "selected.jsonl");
		await writeSession(path, sessionJsonl({ entries: [message("u1", null, "user", [{ type: "text", text: "hello" }])] }));
		const ctx = fakeContext();
		await querySession({ sessionPath: path, question: "What happened?", root, agentDir: join(root, "agent"), ctx });
		expect(ctx.modelRegistry.complete).toHaveBeenCalledOnce();
		const [, nestedContext] = ctx.modelRegistry.complete.mock.calls[0];
		expect(nestedContext.tools).toEqual([]);
		expect(ctx.modelRegistry.getApiKeyAndHeaders).toBeUndefined();
	});

	it("returns a visible warning when the source changes during its snapshot read", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-changing-"));
		const path = join(root, "selected.jsonl");
		await writeSession(path, sessionJsonl({ entries: [message("u1", null, "user", [{ type: "text", text: "hello" }])] }));
		const result = await querySession({
			sessionPath: path,
			question: "What happened?",
			root,
			agentDir: join(root, "agent"),
			ctx: fakeContext(),
			readTranscriptFn: (sourcePath, options) =>
				readTranscript(sourcePath, {
					...options,
					afterSnapshot: () => appendFile(sourcePath, `${JSON.stringify(message("u2", "u1", "user", [{ type: "text", text: "later" }]))}\n`),
				}),
		});
		expect(result.warnings).toContain(
			"The session source changed during the stable snapshot read; evidence and hash reflect the initial-size snapshot.",
		);
	});

	it("bounds nested answer output by characters and lines", () => {
		const bounded = boundAnswer(Array.from({ length: 250 }, () => "x".repeat(100)).join("\n"));
		expect(bounded.truncated).toBe(true);
		expect(bounded.text.length).toBeLessThanOrEqual(12_000);
		expect(bounded.text.split("\n").length).toBeLessThanOrEqual(200);
		expect(bounded.text).toContain("[answer truncated]");
	});

	it("fails rather than falling back when a configured model is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-model-"));
		const agentDir = join(root, "agent");
		const path = join(root, "selected.jsonl");
		await writeSession(path, sessionJsonl({ entries: [message("u1", null, "user", [{ type: "text", text: "hello" }])] }));
		await writeFile(
			join(root, "config.json"),
			JSON.stringify({ queryModel: { provider: "missing", id: "missing-model" } }),
		);
		// Put the configured file at the package's documented agent-relative path.
		const { mkdir, rename } = await import("node:fs/promises");
		await mkdir(agentDir, { recursive: true });
		await rename(join(root, "config.json"), join(agentDir, "session-recall.json"));

		await expect(
			querySession({
				sessionPath: path,
				question: "What happened?",
				root,
				agentDir,
				ctx: fakeContext(),
			}),
		).rejects.toThrow("Configured session recall model is unavailable");
	});
});
