import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sessionRecall from "../src/index";
import { message, sessionJsonl, writeSession } from "./helpers";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("Pi extension integration", () => {
	it("registers both tools and executes search against synthetic sessions", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-recall-extension-"));
		const agentDir = join(base, "agent");
		const sessionDir = join(agentDir, "sessions", "--work--");
		const historical = join(sessionDir, "historical.jsonl");
		const current = join(sessionDir, "current.jsonl");
		await writeSession(
			historical,
			sessionJsonl({
				id: "history",
				entries: [message("u1", null, "user", [{ type: "text", text: "sdk-style-needle" }])],
			}),
		);
		await writeSession(current, sessionJsonl({ id: "current" }));
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const tools = new Map<string, any>();
		sessionRecall({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
		expect([...tools.keys()]).toEqual(["session_search", "session_query"]);
		expect(tools.get("session_search")).toMatchObject({
			promptSnippet: expect.stringContaining("visible user/assistant text"),
			promptGuidelines: [
				expect.stringContaining("only when the user explicitly asks"),
				expect.stringContaining("not proof of current state"),
			],
		});
		expect(tools.get("session_query").promptSnippet).toContain("historical Pi session branch");
		expect(tools.get("session_search").parameters).toMatchObject({
			additionalProperties: false,
			properties: { limit: { maximum: 10 } },
		});
		expect(tools.get("session_query").parameters).toMatchObject({
			additionalProperties: false,
			properties: { question: { maxLength: 1_000 } },
		});

		const result = await tools.get("session_search").execute(
			"call-1",
			{ query: "sdk-style-needle" },
			new AbortController().signal,
			undefined,
			{
				sessionManager: {
					getSessionDir: () => sessionDir,
					getSessionFile: () => current,
				},
			},
		);
		expect(result.details).toMatchObject({
			matchCount: 1,
			candidateLimitReached: false,
			candidateLimit: 500,
		});
		expect(result.content[0].text).toContain("history");
		expect(result.content[0].text).not.toContain("current.jsonl");

		const usage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const model = {
			id: "test-model",
			provider: "test-provider",
			contextWindow: 32_000,
			maxTokens: 2_000,
		};
		const queryResult = await tools.get("session_query").execute(
			"call-2",
			{ sessionPath: historical, question: "What term appeared?" },
			new AbortController().signal,
			undefined,
			{
				model,
				modelRegistry: {
					complete: async () => ({
						role: "assistant",
						content: [{ type: "text", text: "It appeared [E-u1]." }],
						usage,
						stopReason: "stop",
						provider: "test-provider",
						model: "test-model",
						api: "test-api",
						timestamp: Date.now(),
					}),
				},
				sessionManager: {
					getSessionDir: () => sessionDir,
					getSessionFile: () => current,
				},
			},
		);
		expect(queryResult.usage).toEqual(usage);
		expect(queryResult.details.usage).toEqual(usage);

		await expect(
			tools.get("session_search").execute(
				"call-3",
				{ query: "" },
				new AbortController().signal,
				undefined,
				{
					sessionManager: {
						getSessionDir: () => sessionDir,
						getSessionFile: () => current,
					},
				},
			),
		).rejects.toThrow("query must not be empty");
	});
});
