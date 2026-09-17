import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { realpath } from "node:fs/promises";
import { Type } from "typebox";
import { formatQueryResult, querySession } from "./query";
import { effectiveSessionRoot } from "./session-root";
import { formatSearchResult, searchSessions } from "./search";

const ROLES = ["user", "assistant", "both"] as const;

const SearchParams = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: 500,
		description: "One case-insensitive literal token or exact phrase. This is fixed-string search, not regex or semantic search.",
	}),
	cwd: Type.Optional(Type.String({ description: "Only sessions whose header CWD exactly equals this path." })),
	startDate: Type.Optional(Type.String({ description: "Inclusive local date in YYYY-MM-DD form." })),
	endDate: Type.Optional(Type.String({ description: "Inclusive local date in YYYY-MM-DD form." })),
	timezone: Type.Optional(Type.String({ description: "IANA timezone for date filters; defaults to the local timezone." })),
	role: Type.Optional(StringEnum(ROLES, { description: "Visible message role to search; defaults to both." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum sessions to return (default 10)." })),
	includeCurrent: Type.Optional(Type.Boolean({ description: "Include the current session. Defaults to false." })),
}, { additionalProperties: false });

const QueryParams = Type.Object({
	sessionPath: Type.String({ minLength: 1, maxLength: 4096, description: "Absolute .jsonl path returned by session_search; one leading @ is accepted and stripped." }),
	question: Type.String({ minLength: 1, maxLength: 1000, description: "Focused question to answer from this session's visible evidence." }),
	entryId: Type.Optional(Type.String({ description: "Entry anchor returned by search; selects the newest branch containing this entry, including later descendants." })),
	includeCurrent: Type.Optional(Type.Boolean({ description: "Allow querying the current session. Defaults to false." })),
}, { additionalProperties: false });

const resultText = (text: string, details: unknown, usage?: Usage) => ({
	content: [{ type: "text" as const, text }],
	details,
	...(usage ? { usage } : {}),
});

async function canonicalCurrent(path: string | undefined): Promise<string | undefined> {
	if (!path) return undefined;
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}

export default function sessionRecall(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "session_search",
		label: "Session Search",
		description:
			"Search past Pi sessions for a case-insensitive literal string in structurally parsed, visible user/assistant text only. " +
			"Thinking, tool calls/results, images, custom/hidden messages, and summaries are never returned as evidence. " +
			"Use one distinctive token or exact phrase per call, then session_query for a focused synthesis. Current session excluded by default.",
		promptSnippet: "Search prior Pi sessions' visible user/assistant text with provenance",
		promptGuidelines: [
			"Use session_search and session_query only when the user explicitly asks to recall or search historical Pi sessions; never inspect session history proactively.",
			"Treat session_search and session_query results as historical reports, not proof of current state; verify consequential claims against live sources.",
		],
		parameters: SearchParams,
		renderCall: (params, theme) => new Text(theme.fg("toolTitle", `search sessions for ${JSON.stringify(params.query)}`), 0, 0),
		renderResult: (result, _options, theme) => {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const summary = text.split("\n", 1)[0] ?? "Session search complete";
			return new Text(theme.fg("toolOutput", summary), 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentDir = getAgentDir();
			const root = effectiveSessionRoot(ctx.sessionManager.getSessionDir(), agentDir);
			const currentSessionPath = await canonicalCurrent(ctx.sessionManager.getSessionFile());
			const result = await searchSessions({
				...params,
				root,
				currentSessionPath,
				signal,
				onProgress: (message) => onUpdate?.(resultText(message, { status: "searching" })),
			});
			return resultText(formatSearchResult(params.query, result), {
				matchCount: result.matches.length,
				candidateCount: result.candidateCount,
				candidateLimitReached: result.candidateLimitReached,
				candidateLimit: 500,
				backend: result.backend,
				skippedFiles: result.skippedFiles,
			});
		},
	});

	pi.registerTool({
		name: "session_query",
		label: "Session Query",
		description:
			"Ask a focused question about one session path returned by session_search. Validates the path under Pi's effective session root, " +
			"selects the active branch or newest leaf branch containing an entry anchor, redacts visible user/assistant text, and asks a no-tools nested model to answer with evidence-ID citations. " +
			"Historical assistant claims remain reports and require live verification. Current session excluded by default.",
		promptSnippet: "Answer a focused question from one selected historical Pi session branch",
		parameters: QueryParams,
		renderCall: (params, theme) => new Text(theme.fg("toolTitle", `query session: ${params.question}`), 0, 0),
		renderResult: (result, options, theme) => {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const rendered = options.expanded ? text : (text.split("\n").find((line) => line.trim()) ?? "Session query complete");
			return new Text(theme.fg("toolOutput", rendered), 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentDir = getAgentDir();
			const root = effectiveSessionRoot(ctx.sessionManager.getSessionDir(), agentDir);
			const currentSessionPath = await canonicalCurrent(ctx.sessionManager.getSessionFile());
			const result = await querySession({
				sessionPath: params.sessionPath,
				question: params.question,
				entryId: params.entryId,
				includeCurrent: params.includeCurrent,
				root,
				currentSessionPath,
				agentDir,
				ctx,
				signal,
				onProgress: (message) => onUpdate?.(resultText(message, { status: "querying" })),
			});
			return resultText(formatQueryResult(params.question, result), {
				sessionId: result.sessionId,
				path: result.path,
				hash: result.hash,
				branchAnchor: result.branchAnchor,
				includedCount: result.includedCount,
				omittedCount: result.omittedCount,
				redactionCount: result.redactionCount,
				model: result.model,
				usage: result.usage,
				warnings: result.warnings,
			}, result.usage);
		},
	});
}
