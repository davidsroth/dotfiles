/**
 * /cp — copy from the last assistant message, with code-block and block-quote picker.
 *
 * Behavior:
 *   - No fenced code blocks or block quotes in the last assistant message → copies the full response.
 *   - One or more fenced ``` blocks or `>` block quotes → shows a selector:
 *       • "Full response"
 *       • One entry per fenced block (with lang + first-line preview)
 *       • One entry per block quote (with first-line preview)
 *     Selected entry's content is copied to the clipboard.
 *
 * This is a companion to the built-in `/copy`, which always copies the whole
 * response. Built-in commands can't currently be overridden by extensions, so
 * this lives under `/cp`.
 */

import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface CodeBlock {
	/** Info string after the opening fence (e.g. "ts", "bash title=foo"). */
	info: string;
	/** Just the language token (first whitespace-separated word of info). */
	lang: string;
	/** Block contents, without the surrounding fences or the trailing newline. */
	content: string;
	/** 1-based line number of the opening fence in the source text. */
	line: number;
	/** 1-based line number of the closing fence in the source text. */
	endLine: number;
}

interface BlockQuote {
	/** Quote contents, without the leading `>` markers. */
	content: string;
	/** 1-based line number of the first line of the quote. */
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
		const endLine = close === lines.length ? lines.length : close + 1;
		blocks.push({ info, lang, content, line: openLine + 1, endLine });
		i = close + 1;
	}
	return blocks;
}

function extractBlockQuotes(text: string): BlockQuote[] {
	const lines = text.split("\n");
	const quotes: BlockQuote[] = [];

	let i = 0;
	while (i < lines.length) {
		if (!lines[i].startsWith(">")) {
			i++;
			continue;
		}
		const openLine = i;
		const quoteLines: string[] = [];
		while (i < lines.length && lines[i].startsWith(">")) {
			quoteLines.push(lines[i].replace(/^>\s?/, ""));
			i++;
		}
		const content = quoteLines.join("\n");
		if (content.trim().length > 0) {
			quotes.push({ content, line: openLine + 1 });
		}
	}
	return quotes;
}

function filterQuotesInsideBlocks(quotes: BlockQuote[], blocks: CodeBlock[]): BlockQuote[] {
	return quotes.filter((q) => {
		const qEnd = q.line + q.content.split("\n").length - 1;
		return !blocks.some((b) => q.line >= b.line && qEnd <= b.endLine);
	});
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

type Section = { type: "code"; data: CodeBlock } | { type: "quote"; data: BlockQuote };

/** Format a selector label for a section. */
function formatSectionLabel(section: Section, index: number, total: number): string {
	const idx = `${index + 1}/${total}`;
	const lineCount = section.data.content === "" ? 0 : section.data.content.split("\n").length;
	const lines = `${lineCount} line${lineCount === 1 ? "" : "s"}`;
	const preview = previewLine(section.data.content);
	const previewPart = preview ? ` — ${preview}` : "";

	if (section.type === "code") {
		const lang = section.data.lang || "text";
		return `[${idx}] ${lang} (${lines})${previewPart}`;
	}
	return `[${idx}] quote (${lines})${previewPart}`;
}

export default function cpExtension(pi: ExtensionAPI) {
	pi.registerCommand("cp", {
		description: "Copy last assistant message; pick a code block or quote if present",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getEntries();
			const text = getLastAssistantText(entries);
			if (!text) {
				ctx.ui.notify("No agent messages to copy yet.", "warning");
				return;
			}

			const blocks = extractCodeBlocks(text);
			let quotes = extractBlockQuotes(text);
			quotes = filterQuotesInsideBlocks(quotes, blocks);

			const sections: Section[] = [
				...blocks.map((b) => ({ type: "code" as const, data: b })),
				...quotes.map((q) => ({ type: "quote" as const, data: q })),
			];
			sections.sort((a, b) => a.data.line - b.data.line);

			if (sections.length === 0) {
				try {
					await copyToClipboard(text);
					ctx.ui.notify("Copied full response (no code blocks or quotes found)", "info");
				} catch (err) {
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
				}
				return;
			}

			const FULL = "Full response";
			const items = [FULL, ...sections.map((s, i) => formatSectionLabel(s, i, sections.length))];

			const codeCount = blocks.length;
			const quoteCount = quotes.length;
			let prompt: string;
			if (codeCount > 0 && quoteCount > 0) {
				prompt = `Copy what? (${codeCount} code blocks, ${quoteCount} quotes)`;
			} else if (codeCount > 0) {
				prompt = codeCount === 1 ? "Copy what?" : `Copy what? (${codeCount} code blocks)`;
			} else {
				prompt = quoteCount === 1 ? "Copy what?" : `Copy what? (${quoteCount} quotes)`;
			}

			const choice = await ctx.ui.select(prompt, items);
			if (!choice) return; // user cancelled

			let payload: string;
			let label: string;
			if (choice === FULL) {
				payload = text;
				label = "full response";
			} else {
				const idx = items.indexOf(choice) - 1;
				const section = sections[idx];
				if (!section) {
					ctx.ui.notify("Selection out of range", "error");
					return;
				}
				if (section.type === "code") {
					payload = section.data.content;
					label = `code block ${idx + 1}/${sections.length}${section.data.lang ? ` (${section.data.lang})` : ""}`;
				} else {
					payload = section.data.content;
					label = `quote ${idx + 1}/${sections.length}`;
				}
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
