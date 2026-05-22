import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function (pi: ExtensionAPI) {
	pi.registerCommand("recap", {
		description: "Show a short recap of the current session as a notification",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const branch = ctx.sessionManager.getBranch() as SessionEntry[];
			const conversation = buildConversationText(branch);
			if (!conversation.trim()) {
				ctx.ui.notify("No conversation yet to recap", "warning");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No active model — cannot generate recap", "warning");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok) {
				ctx.ui.notify(`Recap failed: ${auth.error}`, "error");
				return;
			}
			if (!auth.apiKey) {
				ctx.ui.notify(`Recap failed: no API key for ${ctx.model.provider}`, "error");
				return;
			}

			ctx.ui.notify("Generating recap…", "info");

			try {
				const response = await complete(
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
						reasoningEffort: "low",
					},
				);

				const recap = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();

				if (!recap) {
					ctx.ui.notify("Recap came back empty", "warning");
					return;
				}

				ctx.ui.notify(recap, "info");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Recap failed: ${msg}`, "error");
			}
		},
	});
}
