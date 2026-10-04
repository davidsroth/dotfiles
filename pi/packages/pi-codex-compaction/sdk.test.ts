import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION,
	type AgentSession, type AgentSessionEvent, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerCodexCompactionExtension } from "./index.ts";
import { NATIVE_COMPACTION_KIND, type JsonObject, type ResponseItem } from "./native-compaction.ts";

// Real Pi SDK, real Codex serialization and SSE parser; only the HTTP boundary is
// fake. No personal resources, auth files, remote catalogs, or network fallbacks.
const BASE_URL = "https://codex-sdk-test.invalid";
const SYSTEM_PROMPT = "Isolated SDK fixture. Use only synthetic test data.";
const fakeToken = `fixture.${Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: "sdk-fixture-account" },
})).toString("base64url")}.unsigned`;
const modelConfig = {
	id: "sdk-codex", name: "SDK Codex fixture", reasoning: false, input: ["text"] as ["text"],
	contextWindow: 10_000, maxTokens: 1_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

type Request = { body: JsonObject & { input: ResponseItem[] }; headers: Headers };
type Reply = { tool?: boolean; inputTokens?: number; text?: string };
let root: string;
let sessions: AgentSession[];
let requests: Request[];
let replies: Reply[];
let extensionErrors: unknown[];
let checkpointCount: number;

function sse(events: JsonObject[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function answer(reply: Reply): Response {
	const item = reply.tool
		? { type: "function_call", id: "fc_sdk", call_id: "call_sdk", name: "fixture_tool", arguments: "{}", status: "completed" }
		: { type: "message", id: `msg_sdk_${requests.length}`, role: "assistant", status: "completed",
			content: [{ type: "output_text", text: reply.text ?? "fixture answer", annotations: [] }] };
	return sse([
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: `resp_sdk_${requests.length}`, status: "completed", output: [item],
			usage: { input_tokens: reply.inputTokens ?? 20, output_tokens: 5, total_tokens: (reply.inputTokens ?? 20) + 5 } } },
	]);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-codex-sdk-"));
	sessions = [];
	requests = [];
	replies = [];
	extensionErrors = [];
	checkpointCount = 0;
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("WebSocket", class { constructor() { throw new Error("SDK tests forbid WebSocket/network access"); } });
	vi.stubGlobal("fetch", vi.fn(async (url: string | URL | globalThis.Request, init?: RequestInit) => {
		expect(String(url)).toBe(`${BASE_URL}/codex/responses`);
		expect(init?.method).toBe("POST");
		const headers = new Headers(init?.headers);
		const raw = headers.get("content-encoding") === "zstd"
			? zstdDecompressSync(init!.body as Uint8Array).toString()
			: String(init?.body);
		const body = JSON.parse(raw) as Request["body"];
		requests.push({ body, headers });
		if (body.input.at(-1)?.type === "compaction_trigger") {
			const item = { type: "compaction", encrypted_content: `opaque-fixture-${++checkpointCount}` };
			return sse([
				{ type: "response.output_item.done", item },
				{ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
			]);
		}
		return answer(replies.shift() ?? {});
	}));
});

afterEach(async () => {
	try {
		for (const session of sessions) { await session.abort(); session.dispose(); }
		expect(extensionErrors, "Pi must not silently swallow extension-hook failures").toEqual([]);
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
});

async function harness(options: {
	file?: string;
	before?: ExtensionFactory[];
	after?: ExtensionFactory[];
	autoCompact?: boolean;
} = {}) {
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	const settingsManager = SettingsManager.inMemory({
		transport: "sse",
		// Tiny manual fixtures need a one-token tail. For the tool fixture the
		// budget must include the six-token result AND its call: Pi cannot cut
		// at a tool result and otherwise falls back to keeping the whole branch.
		compaction: { enabled: options.autoCompact ?? false, reserveTokens: 1_000, keepRecentTokens: options.autoCompact ? 10 : 1 },
		retry: { enabled: false, provider: { maxRetries: 0 } },
		packages: [], extensions: [], skills: [], prompts: [], themes: [],
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
	});
	const provider: ExtensionFactory = (pi) => {
		for (const name of ["openai-codex", "sdk-other-provider"]) {
			pi.registerProvider(name, {
				baseUrl: BASE_URL, apiKey: fakeToken, api: "openai-codex-responses",
				models: [modelConfig, { ...modelConfig, id: "sdk-other-model" }],
				streamSimple: (model, context, streamOptions) => codexStream(model as Model<"openai-codex-responses">, context, streamOptions),
			});
		}
	};
	const loader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPromptOverride: () => SYSTEM_PROMPT, appendSystemPromptOverride: () => [],
		extensionFactories: [provider, ...(options.before ?? []), registerCodexCompactionExtension, ...(options.after ?? [])],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
	expect(loader.getSkills().skills).toEqual([]);
	const manager = options.file
		? SessionManager.open(options.file, join(root, "sessions"), cwd)
		: SessionManager.create(cwd, join(root, "sessions"));
	// Registration is applied by createAgentSession; this explicit synthetic
	// model prevents any fallback to a real/default provider during startup.
	const model: Model<"openai-codex-responses"> = { ...modelConfig, provider: "openai-codex", api: "openai-codex-responses", baseUrl: BASE_URL };
	const { session, extensionsResult } = await createAgentSession({
		cwd, agentDir, modelRuntime, model, thinkingLevel: "off", noTools: "builtin",
		resourceLoader: loader, settingsManager, sessionManager: manager,
	});
	sessions.push(session);
	expect(extensionsResult.errors).toEqual([]);
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
	return { session, manager, events, modelRuntime };
}

function compactionRequests() { return requests.filter(({ body }) => body.input.at(-1)?.type === "compaction_trigger"); }
function normalRequests() { return requests.filter(({ body }) => body.input.at(-1)?.type !== "compaction_trigger"); }
function userTexts(input: ResponseItem[]) {
	return input.filter((item) => item.role === "user").map((item) => typeof item.content === "string"
		? item.content : (item.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(""));
}
function opaqueItems(input: ResponseItem[]) { return input.filter((item) => item.type === "compaction"); }

// Tests intentionally assert SDK state AND final transport payloads, rather than
// calling captured hook callbacks or reproducing Pi's session reconstruction.
function conversationRoles(messages: AgentSession["messages"]) {
	// Pi 0.87+ includes a system checkpoint in persisted/rebuilt context.
	return messages.map((message) => message.role as string).filter((role) => role !== "system");
}

describe(`Pi ${VERSION} SDK native compaction lifecycle`, () => {
	test("manual compaction persists a real non-message boundary without retaining duplicate history", async () => {
		const expectedVersion = process.env.PI_CODEX_TEST_HOST
			? JSON.parse(await readFile(join(process.env.PI_CODEX_TEST_HOST, "package.json"), "utf8")).version
			: "0.85.1";
		expect(VERSION).toBe(expectedVersion);
		const { session, manager, events } = await harness();
		await session.prompt("original user request");
		expect(session.messages.at(-1)?.role).toBe("assistant");
		const result = await session.compact();
		const entry = manager.getBranch().findLast((entry) => entry.type === "compaction")!;
		expect(entry.type).toBe("compaction");
		if (entry.type !== "compaction") throw new Error("Missing persisted compaction");
		expect(manager.getEntry(entry.firstKeptEntryId)).toMatchObject({ type: "custom", customType: "openai-codex-compaction-boundary" });
		expect(result.firstKeptEntryId).toBe(entry.firstKeptEntryId);
		expect(entry.details).toMatchObject({ kind: NATIVE_COMPACTION_KIND });
		const expectedRoles = "systemMessage" in entry && entry.systemMessage
			? ["system", "compactionSummary"] : ["compactionSummary"];
		expect(session.messages.map((message) => message.role)).toEqual(expectedRoles);
		expect(manager.buildSessionContext().messages.map((message) => message.role)).toEqual(expectedRoles);
		expect(events).toContainEqual(expect.objectContaining({ type: "compaction_end", reason: "manual", aborted: false }));
		expect(compactionRequests()).toHaveLength(1);
		expect(compactionRequests()[0].headers.get("x-codex-beta-features")).toContain("remote_compaction_v2");
		expect(compactionRequests()[0].body.instructions).toBe(session.systemPrompt);
		expect(session.systemPrompt).toContain(SYSTEM_PROMPT);
		expect(session.systemPrompt).toContain(join(root, "project"));
		expect(normalRequests()[0].headers.get("x-codex-beta-features")).toContain("remote_compaction_v2");
		await session.prompt("follow up");
		const payload = normalRequests().at(-1)!.body;
		expect(userTexts(payload.input)).toEqual(["original user request", "follow up"]);
		expect(opaqueItems(payload.input)).toEqual([{ type: "compaction", encrypted_content: "opaque-fixture-1" }]);
		expect(JSON.stringify(payload)).not.toContain(entry.summary);
		expect(payload.input.filter((item) => item.role === "assistant")).toEqual([]);
	});

	test("persists and resumes an opaque checkpoint through a fresh SDK session", async () => {
		const first = await harness();
		await first.session.prompt("remember synthetic 42");
		await first.session.compact();
		const file = first.session.sessionFile!;
		expect(await readFile(file, "utf8")).toContain("opaque-fixture-1");
		first.session.dispose();
		sessions.splice(sessions.indexOf(first.session), 1);
		const resumed = await harness({ file });
		expect(resumed.session.sessionId).toBe(first.session.sessionId);
		expect(conversationRoles(resumed.session.messages)).toEqual(["compactionSummary"]);
		await resumed.session.prompt("what was the synthetic value?");
		expect(userTexts(normalRequests().at(-1)!.body.input)).toEqual(["remember synthetic 42", "what was the synthetic value?"]);
		expect(opaqueItems(normalRequests().at(-1)!.body.input)).toHaveLength(1);
		expect(compactionRequests()).toHaveLength(1);
	});

	test.each(["before", "after"] as const)("a persisted fork %s the checkpoint restores only its selected path", async (position) => {
		const source = await harness();
		await source.session.prompt("fork root request");
		const beforeCheckpoint = source.manager.getLeafId()!;
		await source.session.compact();
		const checkpointId = source.manager.getLeafId()!;
		await source.session.prompt("source-only future request");
		const sourceFile = source.session.sessionFile!;
		const sourceBytes = await readFile(sourceFile, "utf8");
		const sourceSessionId = source.session.sessionId;

		// createBranchedSession replaces its manager's active file. Use a fresh
		// manager so the source SDK session remains attached to its own tree.
		const forkManager = SessionManager.open(sourceFile, join(root, "sessions"));
		const forkFile = forkManager.createBranchedSession(position === "after" ? checkpointId : beforeCheckpoint)!;
		expect(forkFile).not.toBe(sourceFile);
		expect(await readFile(sourceFile, "utf8")).toBe(sourceBytes);
		const fork = await harness({ file: forkFile });
		expect(fork.session.sessionId).not.toBe(sourceSessionId);
		expect(fork.manager.getEntry(checkpointId) !== undefined).toBe(position === "after");
		if (position === "before") {
			await fork.session.setModel(fork.modelRuntime.getModel("openai-codex", "sdk-other-model")!);
		}
		const count = requests.length;
		await fork.session.prompt("fork-only request");
		expect(requests).toHaveLength(count + 1);
		const replay = normalRequests().at(-1)!.body;
		expect(replay.model).toBe(position === "after" ? "sdk-codex" : "sdk-other-model");
		expect(userTexts(replay.input)).toEqual(["fork root request", "fork-only request"]);
		expect(opaqueItems(replay.input)).toEqual(position === "after"
			? [{ type: "compaction", encrypted_content: "opaque-fixture-1" }] : []);
		expect(JSON.stringify(replay)).not.toContain("source-only future request");
		expect(await readFile(sourceFile, "utf8")).toBe(sourceBytes);
		expect(compactionRequests()).toHaveLength(1);
	});

	test("tree navigation clears checkpoint replay before the boundary and restores it on return", async () => {
		const { session, manager, modelRuntime } = await harness();
		await session.prompt("tree root request");
		const beforeCheckpoint = manager.getLeafId()!;
		await session.compact();
		const checkpointId = manager.getLeafId()!;
		await session.prompt("abandoned checkpoint future");

		const count = requests.length;
		expect(await session.navigateTree(beforeCheckpoint, { summarize: false })).toMatchObject({ cancelled: false });
		expect(requests).toHaveLength(count);
		expect(manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(session.messages.some((message) => message.role === "compactionSummary")).toBe(false);
		await session.setModel(modelRuntime.getModel("openai-codex", "sdk-other-model")!);
		await session.prompt("alternate pre-checkpoint branch");
		const alternate = normalRequests().at(-1)!.body;
		expect(alternate.model).toBe("sdk-other-model");
		expect(opaqueItems(alternate.input)).toEqual([]);
		expect(userTexts(alternate.input)).toEqual(["tree root request", "alternate pre-checkpoint branch"]);
		expect(requests).toHaveLength(count + 1);

		await session.setModel(modelRuntime.getModel("openai-codex", "sdk-codex")!);
		expect(await session.navigateTree(checkpointId, { summarize: false })).toMatchObject({ cancelled: false });
		expect(requests).toHaveLength(count + 1);
		expect(conversationRoles(session.messages)).toEqual(["compactionSummary"]);
		await session.prompt("returned checkpoint branch");
		const restored = normalRequests().at(-1)!.body;
		expect(opaqueItems(restored.input)).toEqual([{ type: "compaction", encrypted_content: "opaque-fixture-1" }]);
		expect(userTexts(restored.input)).toEqual(["tree root request", "returned checkpoint branch"]);
		expect(JSON.stringify(restored)).not.toContain("abandoned checkpoint future");
		expect(JSON.stringify(restored)).not.toContain("alternate pre-checkpoint branch");
		await session.compact();
		expect(userTexts(compactionRequests()[1].body.input)).toEqual(["tree root request", "returned checkpoint branch"]);
		expect(opaqueItems(compactionRequests()[1].body.input)).toHaveLength(1);
	});

	test("repeated compaction sends the prior checkpoint once and replaces rather than stacks it", async () => {
		const { session } = await harness();
		await session.prompt("first request");
		await session.compact();
		await session.prompt("second request");
		await session.compact();
		const second = compactionRequests()[1].body.input;
		expect(userTexts(second)).toEqual(["first request", "second request"]);
		expect(opaqueItems(second)).toEqual([{ type: "compaction", encrypted_content: "opaque-fixture-1" }]);
		await session.prompt("third request");
		const replay = normalRequests().at(-1)!.body.input;
		expect(userTexts(replay)).toEqual(["first request", "second request", "third request"]);
		expect(opaqueItems(replay)).toEqual([{ type: "compaction", encrypted_content: "opaque-fixture-2" }]);
		expect(session.messages.filter((message) => message.role === "compactionSummary")).toHaveLength(1);
	});

	test.each([
		["model", "openai-codex", "sdk-other-model"],
		["provider", "sdk-other-provider", "sdk-codex"],
	])("blocks a %s switch after a native checkpoint before any transport call", async (_kind, provider, id) => {
		const { session, modelRuntime } = await harness();
		await session.prompt("private synthetic history");
		await session.compact();
		// Leave a completed turn so manual compaction reaches the extension
		// guard rather than Pi rejecting an empty/aborted-only tail first.
		await session.prompt("completed checkpoint tail");
		const count = requests.length;
		await session.setModel(modelRuntime.getModel(provider, id)!);
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		await session.prompt("must not reach the switched provider");
		expect(requests).toHaveLength(count);
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("requires openai-codex:openai-codex-responses:sdk-codex"));
		await expect(session.compact()).rejects.toThrow("Compaction cancelled");
		expect(requests).toHaveLength(count);
		await session.setModel(modelRuntime.getModel("openai-codex", "sdk-codex")!);
		await session.prompt("safe after returning to the original model");
		expect(requests).toHaveLength(count + 1);
		expect(opaqueItems(normalRequests().at(-1)!.body.input)).toHaveLength(1);
	});

	test.each(["before", "after"] as const)("preserves live context transforms registered %s the compaction extension", async (order) => {
		const transform: ExtensionFactory = (pi) => pi.on("context", (event) => ({
			messages: event.messages.map((message) => message.role === "user"
				? { ...message, content: typeof message.content === "string"
					? message.content.replaceAll("unredacted", "redacted")
					: message.content.map((part) => part.type === "text" ? { ...part, text: part.text.replaceAll("unredacted", "redacted") } : part) }
				: message),
		}));
		const { session } = await harness({ [order]: [transform] });
		await session.prompt("unredacted old request");
		await session.compact();
		expect(userTexts(compactionRequests()[0].body.input)).toEqual(["redacted old request"]);
		await session.prompt("unredacted live request");
		const replay = normalRequests().at(-1)!.body.input;
		expect(userTexts(replay)).toEqual(["redacted old request", "redacted live request"]);
		expect(JSON.stringify(replay)).not.toContain("unredacted");
		await session.compact();
		expect(userTexts(compactionRequests()[1].body.input)).toEqual(["redacted old request", "redacted live request"]);
	});

	test("Pi's mid-run compaction continues after a completed tool without a synthetic user prompt", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "synthetic tool output" }], details: {} }));
		const tool: ExtensionFactory = (pi) => pi.registerTool({
			name: "fixture_tool", label: "Fixture", description: "Return synthetic test data", parameters: Type.Object({}), execute,
		});
		const { session, events } = await harness({ before: [tool], autoCompact: true });
		// Pi needs an earlier completed turn to find a cut before a tool pair.
		await session.prompt("synthetic setup turn");
		replies.push({ tool: true, inputTokens: 9_500 }, { text: "continued after tool and compaction" });
		await session.prompt("run the fixture tool and continue");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(compactionRequests()).toHaveLength(1);
		const compactInput = compactionRequests()[0].body.input;
		expect(compactInput).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_sdk", name: "fixture_tool" }));
		expect(compactInput).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_sdk", output: "synthetic tool output" }));
		expect(normalRequests()).toHaveLength(3);
		const replay = normalRequests()[2].body.input;
		expect(opaqueItems(replay)).toHaveLength(1);
		expect(userTexts(replay)).toEqual(["synthetic setup turn", "run the fixture tool and continue"]);
		expect(replay.some((item) => item.type === "function_call" || item.type === "function_call_output")).toBe(false);
		expect(events).toContainEqual(expect.objectContaining({ type: "compaction_end", reason: "threshold", aborted: false }));
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", content: [expect.objectContaining({ text: "continued after tool and compaction" })] });
	});
});
