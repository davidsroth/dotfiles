/**
 * /cp — copy from the last assistant message, with code-block picker.
 *
 * Behavior:
 *   - No fenced code blocks in the last assistant message → copies the full response.
 *   - One or more fenced ``` blocks → shows a selector:
 *       • "Full response"
 *       • One entry per fenced block (with lang + first-line preview)
 *     Selected entry's content is copied to the clipboard.
 *
 * This is a companion to the built-in `/copy`, which always copies the whole
 * response. Built-in commands can't currently be overridden by extensions, so
 * this lives under `/cp`.
 */

import { copyToClipboard, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface CodeBlock {
	/** Info string after the opening fence (e.g. "ts", "bash title=foo"). */
	info: string;
	/** Just the language token (first whitespace-separated word of info). */
	lang: string;
	/** Block contents, without the surrounding fences or the trailing newline. */
	content: string;
	/** 1-based line number of the opening fence in the source text. */
	line: number;
}

/**
 * Extract fenced code blocks from a markdown string.
 *
 * Supports fences of 3+ backticks or 3+ tildes. The closing fence must use the
 * same character and at least as many of them as the opener (CommonMark rule).
 * This lets blocks contain shorter fences (e.g. a ```` ```ts ```` block inside
 * a ``````` `````md ``````` outer block).
 */
function extractCodeBlocks(text: string): CodeBlock[] {
	const lines = text.split("\n");
	const blocks: CodeBlock[] = [];
	const fenceRe = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

	let i = 0;
	while (i < lines.length) {
		const m = lines[i].match(fenceRe);
		if (!m) {
			i++;
			continue;
		}
		const fenceChar = m[2][0];
		const fenceLen = m[2].length;
		const info = m[3].trim();

		// Tilde fences allow backticks in info; backtick fences don't.
		if (fenceChar === "`" && info.includes("`")) {
			i++;
			continue;
		}

		const openLine = i;
		let close = -1;
		for (let j = i + 1; j < lines.length; j++) {
			const cm = lines[j].match(/^(\s{0,3})(`{3,}|~{3,})\s*$/);
			if (cm && cm[2][0] === fenceChar && cm[2].length >= fenceLen) {
				close = j;
				break;
			}
		}
		if (close === -1) {
			// Unterminated fence — treat the rest of the doc as the block body.
			close = lines.length;
		}

		const content = lines.slice(openLine + 1, close).join("\n");
		const lang = info.split(/\s+/)[0] ?? "";
		blocks.push({ info, lang, content, line: openLine + 1 });
		i = close + 1;
	}
	return blocks;
}

/** Pull the last assistant message's text from the session, joining text parts. */
function getLastAssistantText(entries: readonly any[]): string | undefined {
	// Walk entries backwards looking for the last assistant message.
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || msg.role !== "assistant") continue;
		// Skip aborted empty messages, mirroring the built-in /copy.
		if (msg.stopReason === "aborted" && (!msg.content || msg.content.length === 0)) continue;

		let text = "";
		for (const part of msg.content ?? []) {
			if (part?.type === "text" && typeof part.text === "string") {
				text += part.text;
			}
		}
		const trimmed = text.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	return undefined;
}

/** Build a one-line, terminal-friendly preview of a block's content. */
function previewLine(content: string, max = 60): string {
	const firstNonEmpty = content.split("\n").find((l) => l.trim().length > 0) ?? "";
	const collapsed = firstNonEmpty.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, max - 1)}…`;
}

/** Format a block label for the selector. */
function formatBlockLabel(block: CodeBlock, index: number, total: number): string {
	const idx = `${index + 1}/${total}`;
	const lang = block.lang || "text";
	const lineCount = block.content === "" ? 0 : block.content.split("\n").length;
	const lines = `${lineCount} line${lineCount === 1 ? "" : "s"}`;
	const preview = previewLine(block.content);
	const previewPart = preview ? ` — ${preview}` : "";
	return `[${idx}] ${lang} (${lines})${previewPart}`;
}

export default function cpExtension(pi: ExtensionAPI) {
	pi.registerCommand("cp", {
		description: "Copy last assistant message; pick a code block if present",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getEntries();
			const text = getLastAssistantText(entries);
			if (!text) {
				ctx.ui.notify("No agent messages to copy yet.", "warning");
				return;
			}

			const blocks = extractCodeBlocks(text);

			if (blocks.length === 0) {
				try {
					await copyToClipboard(text);
					ctx.ui.notify("Copied full response (no code blocks found)", "info");
				} catch (err) {
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
				}
				return;
			}

			const FULL = "Full response";
			const items = [FULL, ...blocks.map((b, i) => formatBlockLabel(b, i, blocks.length))];

			const choice = await ctx.ui.select(
				blocks.length === 1 ? "Copy what?" : `Copy what? (${blocks.length} code blocks)`,
				items,
			);
			if (!choice) return; // user cancelled

			let payload: string;
			let label: string;
			if (choice === FULL) {
				payload = text;
				label = "full response";
			} else {
				const idx = items.indexOf(choice) - 1;
				const block = blocks[idx];
				if (!block) {
					ctx.ui.notify("Selection out of range", "error");
					return;
				}
				payload = block.content;
				label = `code block ${idx + 1}/${blocks.length}${block.lang ? ` (${block.lang})` : ""}`;
			}

			try {
				await copyToClipboard(payload);
				ctx.ui.notify(`Copied ${label} to clipboard`, "info");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});
}
