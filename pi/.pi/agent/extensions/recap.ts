import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_IDLE_MINUTES = 30;
const idleMinutes = (() => {
	const parsed = Number(process.env.PI_RECAP_IDLE_MINUTES);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_MINUTES;
})();
const IDLE_TIMEOUT_MS = idleMinutes * 60_000;

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") out.push(block.text);
	}
	return out;
};

const extractToolNames = (content: unknown): string[] => {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "toolCall" && typeof block.name === "string") out.push(block.name);
	}
	return out;
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const lines: string[] = [];
		const textParts = extractTextParts(entry.message.content);
		if (textParts.length > 0) {
			const label = role === "user" ? "User" : "Assistant";
			const text = textParts.join("\n").trim();
			if (text) lines.push(`${label}: ${text}`);
		}
		if (role === "assistant") {
			const tools = extractToolNames(entry.message.content);
			if (tools.length > 0) lines.push(`(tools: ${tools.join(", ")})`);
		}
		if (lines.length > 0) sections.push(lines.join("\n"));
	}
	return sections.join("\n\n");
};

const buildRecapPrompt = (conversation: string): string =>
	[
		"Produce a very short recap of this pi coding session, suitable for a toast notification.",
		"Constraints:",
		"- Max 2 sentences, ~280 characters total.",
		"- Plain text, no markdown, no headings, no bullet points.",
		"- Focus on: what we were doing, current state, and the immediate next step.",
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");

type RecapResult =
	| { kind: "recap"; text: string }
	| { kind: "warning" | "error"; text: string };

const generateRecap = async (ctx: ExtensionContext): Promise<RecapResult> => {
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	const conversation = buildConversationText(branch);
	if (!conversation.trim()) return { kind: "warning", text: "No conversation yet to recap" };
	if (!ctx.model) return { kind: "warning", text: "No active model — cannot generate recap" };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) return { kind: "error", text: `Recap failed: ${auth.error}` };
	if (!auth.apiKey) {
		return { kind: "error", text: `Recap failed: no API key for ${ctx.model.provider}` };
	}

	const response = await completeSimple(
		ctx.model,
		{
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildRecapPrompt(conversation) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			reasoning: "low",
		},
	);

	const recap = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
	return recap ? { kind: "recap", text: recap } : { kind: "warning", text: "Recap came back empty" };
};

export default function (pi: ExtensionAPI) {
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let recapInFlight = false;

	const clearIdleTimer = () => {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};

	const scheduleIdleRecap = (ctx: ExtensionContext) => {
		clearIdleTimer();
		if (!ctx.hasUI || !buildConversationText(ctx.sessionManager.getBranch() as SessionEntry[]).trim()) return;

		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			if (!ctx.isIdle() || recapInFlight) return;
			recapInFlight = true;
			ctx.ui.notify("Generating recap…", "info");
			generateRecap(ctx)
				.then((result) => {
					// Use the same notification renderer as an explicit /recap so
					// formatting and lifetime stay consistent.
					ctx.ui.notify(result.text, result.kind === "recap" ? "info" : result.kind);
				})
				.catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Recap failed: ${msg}`, "error");
				})
				.finally(() => {
					recapInFlight = false;
				});
		}, IDLE_TIMEOUT_MS);
	};

	pi.on("session_start", async (_event, ctx) => {
		scheduleIdleRecap(ctx);
	});
	pi.on("agent_start", async () => {
		clearIdleTimer();
	});
	pi.on("agent_settled", async (_event, ctx) => {
		scheduleIdleRecap(ctx);
	});
	pi.on("input", async (_event, ctx) => {
		// User-submitted input counts as activity. agent_start will clear this
		// timer again for a real turn; this also covers handled commands.
		scheduleIdleRecap(ctx);
	});
	pi.on("session_shutdown", async () => {
		clearIdleTimer();
	});

	pi.registerCommand("recap", {
		description: "Show a short recap of the current session as a notification",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (recapInFlight) {
				ctx.ui.notify("A recap is already being generated", "info");
				return;
			}
			scheduleIdleRecap(ctx);
			recapInFlight = true;
			ctx.ui.notify("Generating recap…", "info");
			try {
				const result = await generateRecap(ctx);
				ctx.ui.notify(result.text, result.kind === "recap" ? "info" : result.kind);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Recap failed: ${msg}`, "error");
			} finally {
				recapInFlight = false;
				scheduleIdleRecap(ctx);
			}
		},
	});
}
