/**
 * Plan — Lightweight plan review for pi.
 *
 * Agent calls submit_plan with a markdown file path.
 * User can run /markup to review the agent's last message.
 * Browser opens a clean review page: select text to annotate, reply, approve, or send feedback.
 * Inherits the active pi theme for colors.
 */

import { exec, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────

interface PlanComment {
	id: number;
	selectedText: string;
	context?: string;
	text: string;
}

type ReviewAction = "approve" | "send-feedback" | "reply";

interface ReviewResult {
	action?: ReviewAction;
	approved: boolean;
	feedback?: string;
	comments?: PlanComment[];
}

interface ReviewButton {
	action: ReviewAction;
	label: string;
	approved: boolean;
	variant: "primary" | "success";
	doneText: string;
}

interface ReviewPageOptions {
	title: string;
	sourceLabel: string;
	emptyText: string;
	footerPlaceholder: string;
	buttons: ReviewButton[];
	defaultAction: ReviewAction;
	textareaShortcutAction: ReviewAction;
	timeoutFeedback: string;
}

// ── Utilities ──────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#x27;");
}

function scriptJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

function resolveMarkdownPath(input: string, cwd: string): string | null {
	if (!input) return null;
	const abs = resolve(cwd, input);
	return new Set([".md", ".mdx"]).has(extname(abs).toLowerCase()) ? abs : null;
}

interface AssistantTextResult {
	text: string;
	entryId?: string;
	timestamp?: string;
	incompleteReason?: string;
}

function findLastAssistantText(branchEntries: readonly unknown[]): AssistantTextResult | null {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i] as { type?: string; id?: string; timestamp?: string; message?: unknown } | null | undefined;
		if (!entry || entry.type !== "message") continue;
		const msg = entry.message as
			| {
					role?: string;
					stopReason?: string;
					content?: Array<{ type?: string; text?: string }>;
				}
			| undefined;
		if (!msg || msg.role !== "assistant") continue;
		if (msg.stopReason && msg.stopReason !== "stop") {
			return { text: "", entryId: entry.id, timestamp: entry.timestamp, incompleteReason: msg.stopReason };
		}
		const textParts = (msg.content ?? [])
			.filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text);
		if (textParts.length > 0) {
			return { text: textParts.join("\n"), entryId: entry.id, timestamp: entry.timestamp };
		}
	}
	return null;
}

function loadTheme(ctx: ExtensionContext): { colors: Record<string, string>; isLight: boolean } {
	let colors: Record<string, string> = {};
	let isLight = false;
	try {
		const theme = (ctx as unknown as Record<string, unknown>)?.theme;
		if (theme && typeof theme === "object") {
			const themeAny = theme as Record<string, unknown>;
			const sourcePath = themeAny.sourcePath ? String(themeAny.sourcePath) : undefined;
			if (sourcePath) {
				const json = JSON.parse(readFileSync(sourcePath, "utf-8")) as Record<string, unknown>;
				colors = resolveThemeColors(json);
				isLight = json.name === "light" || String(json.name).toLowerCase().includes("light");
			}
		}
	} catch (e) {
		console.log("[Plan] theme load failed:", e);
	}
	return { colors, isLight };
}

function renderInline(md: string): string {
	const codeSpans: string[] = [];
	let html = escapeHtml(md).replace(/`([^`\n]+)`/g, (_match, code: string) => {
		const token = `@@CODE${codeSpans.length}@@`;
		codeSpans.push(`<code>${code}</code>`);
		return token;
	});

	html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");
	html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
	html = html.replace(/___(.+?)___/g, "<strong><em>$1</em></strong>");
	html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
	html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
	html = html.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
	html = html.replace(
		/\[([^\]]+)\]\((https?:\/\/[^\s)]+|#[^\s)]+|\/[^\s)]+)\)/g,
		'<a href="$2" target="_blank" rel="noreferrer">$1</a>',
	);

	for (let i = 0; i < codeSpans.length; i++) {
		html = html.replace(`@@CODE${i}@@`, codeSpans[i] ?? "");
	}
	return html;
}

function isHr(line: string): boolean {
	return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function isFenceStart(line: string): RegExpMatchArray | null {
	return line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^`]*)\s*$/);
}

function isTableSeparator(line: string): boolean {
	return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
	let trimmed = line.trim();
	if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
	if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
	return trimmed.split("|").map((cell) => cell.trim());
}

function isBlockStart(lines: string[], index: number): boolean {
	const line = lines[index] ?? "";
	const next = lines[index + 1] ?? "";
	return (
		line.trim() === "" ||
		isFenceStart(line) !== null ||
		/^\s{0,3}#{1,6}\s+/.test(line) ||
		isHr(line) ||
		/^\s{0,3}>/.test(line) ||
		/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) ||
		(line.includes("|") && isTableSeparator(next))
	);
}

interface ListLine {
	indent: number;
	ordered: boolean;
	text: string;
}

function parseListLine(line: string): ListLine | null {
	const match = line.match(/^(\s*)((?:[-*+])|(?:\d+[.)]))\s+(.+)$/);
	if (!match) return null;
	return {
		indent: (match[1] ?? "").replace(/\t/g, "    ").length,
		ordered: /\d/.test(match[2] ?? ""),
		text: match[3] ?? "",
	};
}

function renderListItemText(text: string): { html: string; className: string } {
	const task = text.match(/^\[([ xX])\]\s+(.+)$/);
	if (!task) return { html: renderInline(text), className: "" };
	const checked = (task[1] ?? "").toLowerCase() === "x";
	return {
		html: `<span class="bx">[${checked ? "x" : " "}]</span> ${renderInline(task[2] ?? "")}`,
		className: ` class="task${checked ? " done" : ""}"`,
	};
}

function renderListAt(lines: string[], start: number, indent: number, ordered: boolean): { html: string; next: number } {
	const tag = ordered ? "ol" : "ul";
	const items: string[] = [];
	let i = start;

	while (i < lines.length) {
		const parsed = parseListLine(lines[i] ?? "");
		if (!parsed || parsed.indent < indent) break;

		if (parsed.indent > indent) {
			if (items.length === 0) break;
			const nested = renderListAt(lines, i, parsed.indent, parsed.ordered);
			items[items.length - 1] = `${items[items.length - 1]?.replace(/<\/li>$/, "") ?? ""}${nested.html}</li>`;
			i = nested.next;
			continue;
		}

		if (parsed.ordered !== ordered) break;

		const rendered = renderListItemText(parsed.text);
		let itemHtml = `<li${rendered.className}>${rendered.html}`;
		i++;

		while (i < lines.length) {
			const next = parseListLine(lines[i] ?? "");
			if (!next || next.indent <= indent) break;
			const nested = renderListAt(lines, i, next.indent, next.ordered);
			itemHtml += nested.html;
			i = nested.next;
		}

		items.push(`${itemHtml}</li>`);
	}

	return { html: `<${tag}>${items.join("\n")}</${tag}>`, next: i };
}

function renderListBlock(lines: string[], start: number): { html: string; next: number } | null {
	const first = parseListLine(lines[start] ?? "");
	if (!first) return null;
	return renderListAt(lines, start, first.indent, first.ordered);
}

function mdToHtml(md: string): string {
	const lines = md.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line.trim() === "") { i++; continue; }

		const fence = isFenceStart(line);
		if (fence) {
			const marker = fence[1] ?? "```";
			const char = marker[0] ?? "`";
			const len = marker.length;
			const lang = (fence[2] ?? "").trim().split(/\s+/)[0] ?? "";
			i++;
			const code: string[] = [];
			while (i < lines.length) {
				const candidate = lines[i] ?? "";
				if (new RegExp(`^\\s{0,3}${char}{${len},}\\s*$`).test(candidate)) { i++; break; }
				code.push(candidate);
				i++;
			}
			const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
			out.push(`<pre${langAttr}><code>${escapeHtml(code.join("\n"))}</code></pre>`);
			continue;
		}

		const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (heading) {
			const level = heading[1]?.length ?? 1;
			out.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
			i++;
			continue;
		}

		if (isHr(line)) {
			out.push("<hr>");
			i++;
			continue;
		}

		if (/^\s{0,3}>/.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? "")) {
				quoted.push((lines[i] ?? "").replace(/^\s{0,3}>\s?/, ""));
				i++;
			}
			out.push(`<blockquote>${mdToHtml(quoted.join("\n"))}</blockquote>`);
			continue;
		}

		if (line.includes("|") && isTableSeparator(lines[i + 1] ?? "")) {
			const headers = splitTableRow(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
				rows.push(splitTableRow(lines[i] ?? ""));
				i++;
			}
			out.push(
				`<table><thead><tr>${headers.map((h) => `<th>${renderInline(h)}</th>`).join("")}</tr></thead>` +
				`<tbody>${rows.map((row) => `<tr>${headers.map((_h, idx) => `<td>${renderInline(row[idx] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
			);
			continue;
		}

		const listBlock = renderListBlock(lines, i);
		if (listBlock) {
			out.push(listBlock.html);
			i = listBlock.next;
			continue;
		}

		const para: string[] = [];
		while (i < lines.length && !isBlockStart(lines, i)) {
			para.push(lines[i] ?? "");
			i++;
		}
		if (para.length === 0) {
			out.push(`<p>${renderInline(line)}</p>`);
			i++;
		} else {
			out.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
		}
	}

	return out.join("\n");
}

// ── Theme helpers ──────────────────────────────────────────────────────

function ansi256ToHex(index: number): string {
	const basic = ["#000000","#800000","#008000","#808000","#000080","#800080","#008080","#c0c0c0","#808080","#ff0000","#00ff00","#ffff00","#0000ff","#ff00ff","#00ffff","#ffffff"];
	if (index < 16) return basic[index];
	if (index < 232) {
		const ci = index - 16;
		const r = Math.floor(ci / 36), g = Math.floor((ci % 36) / 6), b = ci % 6;
		const h = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${h(r)}${h(g)}${h(b)}`;
	}
	const gray = 8 + (index - 232) * 10;
	const gh = gray.toString(16).padStart(2, "0");
	return `#${gh}${gh}${gh}`;
}

function contrastText(bgHex: string): string {
	const hex = bgHex.replace("#", "");
	const r = parseInt(hex.slice(0, 2), 16);
	const g = parseInt(hex.slice(2, 4), 16);
	const b = parseInt(hex.slice(4, 6), 16);
	const yiq = (r * 299 + g * 587 + b * 114) / 1000;
	return yiq >= 140 ? "#111111" : "#ffffff";
}

function resolveThemeColors(json: Record<string, unknown>): Record<string, string> {
	const vars = (json.vars as Record<string, string | number>) ?? {};
	const raw = (json.colors as Record<string, string | number>) ?? {};
	const resolved: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v === "number") resolved[k] = ansi256ToHex(v);
		else if (typeof v === "string" && v.startsWith("#")) resolved[k] = v;
		else if (typeof v === "string" && vars[v]) {
			const rv = vars[v];
			resolved[k] = typeof rv === "number" ? ansi256ToHex(rv) : rv;
		} else if (typeof v === "string" && v !== "") resolved[k] = v;
	}
	return resolved;
}

function buildCss(colors: Record<string, string>, isLight: boolean): string {
	const accent = colors.accent ?? (isLight ? "#2563eb" : "#60a5fa");
	const success = colors.success ?? (isLight ? "#16a34a" : "#22c55e");
	const error = colors.error ?? (isLight ? "#dc2626" : "#ef4444");
	const border = colors.border ?? (isLight ? "#ddd" : "#444");
	const muted = colors.muted ?? (isLight ? "#666" : "#999");
	const pageBg = isLight ? "#faf9f7" : "#1a1a1a";
	const pageFg = isLight ? "#1a1a1a" : "#e8e6e3";
	const codeBg = isLight ? "#f3f3f3" : "#2a2a2a";
	const hl = isLight ? "#fef3c7" : "#451a03";

	return `
:root {
  --surface: ${pageBg};
  --surface-elevated: color-mix(in oklab, ${pageBg} 95%, ${pageFg});
  --text: ${pageFg};
  --text-muted: ${muted};
  --border: ${border};
  --code-bg: ${codeBg};
  --hl: ${hl};
  --side: 360px;

  --interactive: ${accent};
  --interactive-text: ${contrastText(accent)};
  --interactive-hover: color-mix(in oklab, var(--interactive) 80%, black);
  --interactive-subtle: color-mix(in oklab, var(--interactive) 15%, var(--surface));

  --success: ${success};
  --success-text: ${contrastText(success)};
  --success-hover: color-mix(in oklab, var(--success) 80%, black);

  --danger: ${error};
}

* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  font-family: "Fira Code Nerd Font", "Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, "Courier New", monospace;
  background: var(--surface); color: var(--text); line-height: 1.65; display: flex;
  font-size: 14px;
}
main { flex: 1; overflow-y: auto; padding: 32px 40px; }
main h1 { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.01em; border-bottom: 1px solid var(--border); padding-bottom: .35em; margin-bottom: .7em; }
main h2 { font-size: 1.15rem; font-weight: 700; letter-spacing: -0.01em; margin-top: 1.6em; margin-bottom: .4em; }
main h3 { font-size: 1.05rem; font-weight: 700; letter-spacing: -0.01em; margin-top: 1.3em; }
main p { margin: .6em 0; }
main a { color: var(--interactive); text-decoration: none; border-bottom: 1px solid var(--interactive-subtle); }
main a:hover { border-bottom-color: var(--interactive); }
main blockquote { border-left: 2px solid var(--border); margin: .8em 0; padding-left: 1em; color: var(--text-muted); }
main code { font-family: inherit; font-size: .92em; background: var(--code-bg); padding: .05em .3em; border-radius: 2px; }
main pre { background: var(--code-bg); padding: .9em; border-radius: 2px; overflow-x: auto; line-height: 1.5; margin: .7em 0; border: 1px solid var(--border); }
main pre code { padding: 0; background: none; white-space: pre; }
main pre[data-lang]::before { content: attr(data-lang); display: block; color: var(--text-muted); font-size: .76rem; margin-bottom: .4em; text-transform: uppercase; letter-spacing: .04em; }
main ul, main ol { margin: .55em 0 .75em 1.45em; padding: 0; }
main li { margin: .25em 0; padding-left: .15em; }
main li > ul, main li > ol { margin-top: .2em; margin-bottom: .25em; margin-left: 1.25em; }
main li.task { list-style: none; margin-left: -1.25em; }
main li.task > ul, main li.task > ol { margin-left: 2.5em; }
main li.task .bx { user-select: none; color: var(--text-muted); margin-right: .45em; }
main li.task.done { color: var(--text-muted); }
main del { color: var(--text-muted); }
main table { width: 100%; border-collapse: collapse; margin: .9em 0; font-size: .92em; }
main th, main td { border: 1px solid var(--border); padding: .35em .55em; text-align: left; vertical-align: top; }
main th { background: var(--code-bg); font-weight: 700; }
main hr { border: none; border-top: 1px solid var(--border); margin: 1.4em 0; }

.hl { background: var(--interactive-subtle); border-bottom: 2px solid var(--interactive); color: inherit; padding: 0 2px; border-radius: 1px; }
.path { color: var(--text-muted); font-size: .82rem; margin-bottom: 1.6em; }

aside { width: var(--side); border-left: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; }
aside header { padding: 12px 16px; border-bottom: 1px solid var(--border); font-weight: 700; font-size: .9rem; display: flex; justify-content: space-between; align-items: center; text-transform: uppercase; letter-spacing: 0.04em; }
#list { flex: 1; overflow-y: auto; padding: 12px 14px; }
.empty { color: var(--text-muted); text-align: center; padding: 32px 10px; font-size: .88rem; }
.c { background: var(--code-bg); border-radius: 2px; padding: 10px; margin-bottom: 10px; font-size: .88rem; border: 1px solid var(--border); }
.c .q { color: var(--text-muted); font-style: italic; margin-bottom: 6px; padding-left: 8px; border-left: 2px solid var(--interactive); font-size: .82em; word-break: break-word; }
.c .body { margin-bottom: 6px; font-size: .88rem; line-height: 1.5; }
.c textarea { width: 100%; border: 1px solid var(--border); border-radius: 2px; padding: 6px 8px; font-family: inherit; font-size: .82rem; background: var(--surface); color: var(--text); resize: vertical; min-height: 44px; line-height: 1.5; }
.c .acts { display: flex; gap: 6px; margin-top: 6px; }
.c .acts button { font-size: .78rem; padding: 3px 10px; border: none; border-radius: 2px; cursor: pointer; font-family: inherit; }

footer { padding: 12px; border-top: 1px solid var(--border); }
footer textarea { width: 100%; min-height: 48px; resize: vertical; padding: 6px 8px; font-family: inherit; font-size: .88rem; border: 1px solid var(--border); border-radius: 2px; background: var(--surface); color: var(--text); margin-bottom: 8px; line-height: 1.5; }
footer .row { display: flex; gap: 6px; }
footer .row button { flex: 1; padding: 8px; font-size: .88rem; font-weight: 600; border: none; border-radius: 2px; cursor: pointer; font-family: inherit; letter-spacing: -0.01em; }
button.primary { background: var(--interactive); color: var(--interactive-text); }
button.primary:hover { background: var(--interactive-hover); }
button.success { background: var(--success); color: var(--success-text); }
button.success:hover { background: var(--success-hover); }
#load { display: none; padding: 12px; text-align: center; color: var(--text-muted); font-size: .88rem; }

.float {
  position: absolute;
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px; background: var(--surface-elevated);
  border: 1px solid var(--border); border-radius: 2px;
  box-shadow: 0 4px 16px rgba(0,0,0,.2);
  min-width: 220px; z-index: 100;
}
.float textarea {
  width: 100%; min-height: 50px; resize: vertical;
  border: 1px solid var(--border); border-radius: 2px;
  padding: 6px 8px; font-family: inherit; font-size: .85rem;
  background: var(--surface); color: var(--text); line-height: 1.5;
}
.float .row { display: flex; gap: 6px; justify-content: flex-end; }
.float .row button {
  font-size: .78rem; padding: 4px 10px; border-radius: 2px; cursor: pointer; border: none; font-family: inherit;
}
.float .row .cancel { background: transparent; color: var(--text-muted); border: 1px solid var(--border)!important; }
.float .row .ok { background: var(--interactive); color: #fff; }
.notice { padding: 14px; text-align: center; font-weight: 600; font-family: inherit; }
`;
}

// ── Browser ────────────────────────────────────────────────────────────

async function openBrowser(url: string): Promise<void> {
	const cmd = process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
	try { await execAsync(cmd); } catch { /* user navigates manually */ }
}

async function getFrontmostAppName(): Promise<string | null> {
	if (process.platform !== "darwin") return null;
	try {
		const { stdout } = await execFileAsync("osascript", [
			"-e",
			'tell application "System Events" to get name of first application process whose frontmost is true',
		]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

function focusApp(appName: string | null): void {
	if (process.platform !== "darwin" || !appName) return;
	setTimeout(() => {
		void execFileAsync("osascript", ["-e", `tell application ${JSON.stringify(appName)} to activate`]).catch(() => undefined);
	}, 800);
}

const PLAN_REVIEW_OPTIONS: ReviewPageOptions = {
	title: "Plan Review",
	sourceLabel: "Plan",
	emptyText: "No comments yet. Select text in the plan to add one.",
	footerPlaceholder: "Plan feedback (optional)",
	buttons: [
		{ action: "send-feedback", label: "Send Feedback", approved: false, variant: "primary", doneText: "Feedback sent. Closing..." },
		{ action: "approve", label: "Approve", approved: true, variant: "success", doneText: "Approved. Closing..." },
	],
	defaultAction: "approve",
	textareaShortcutAction: "send-feedback",
	timeoutFeedback: "Review timed out. Please resubmit.",
};

const LAST_REPLY_OPTIONS: ReviewPageOptions = {
	title: "Reply to Last Message",
	sourceLabel: "Last assistant message",
	emptyText: "No notes yet. Select text in the message to add one, or type a reply below.",
	footerPlaceholder: "Reply (optional)",
	buttons: [
		{ action: "reply", label: "Reply", approved: false, variant: "primary", doneText: "Reply captured. Closing..." },
	],
	defaultAction: "reply",
	textareaShortcutAction: "reply",
	timeoutFeedback: "",
};

function buildPage(content: string, options: ReviewPageOptions, colors: Record<string, string>, isLight: boolean, nonce: string): string {
	const body = mdToHtml(content);
	const css = buildCss(colors, isLight);
	const buttons = options.buttons.map((button) => (
		`<button class="${button.variant}" data-action="${escapeHtml(button.action)}" data-approved="${button.approved ? "true" : "false"}" data-done="${escapeHtml(button.doneText)}">[ ${escapeHtml(button.label)} ]</button>`
	)).join("\n      ");
	const pageOptions = scriptJson({
		defaultAction: options.defaultAction,
		textareaShortcutAction: options.textareaShortcutAction,
		emptyText: options.emptyText,
		nonce,
	});
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Cache-Control" content="no-store">
<title>${escapeHtml(options.title)} — ${escapeHtml(options.sourceLabel)}</title>
<style>${css}</style>
</head>
<body>
<main id="doc">
  <div class="path">${escapeHtml(options.sourceLabel)}</div>
  ${body}
</main>
<aside>
  <header><span>Notes</span><span id="cnt" style="color:var(--text-muted);font-weight:400;font-size:.82rem;">0</span></header>
  <div id="list"><div class="empty">${escapeHtml(options.emptyText)}</div></div>
  <div id="load">Sending…</div>
  <footer id="foot">
    <textarea id="general" placeholder="${escapeHtml(options.footerPlaceholder)}"></textarea>
    <div class="row">
      ${buttons}
    </div>
  </footer>
</aside>

<script>
const pageOptions=${pageOptions};

let comments=[];
let nextId=1;
let floater=null;
let draft=null;
function $(id){return document.getElementById(id);}

function unwrapHighlight(span){
  if(!span||!span.parentNode)return;
  const parent=span.parentNode;
  const t=document.createTextNode(span.textContent||'');
  parent.replaceChild(t,span);
  parent.normalize();
}

function cancelDraft(){
  if(draft&&draft.spans){
    for(const span of [...draft.spans].reverse())unwrapHighlight(span);
  }
  draft=null;hideF();
}

function textNodesInRange(range){
  const doc=$('doc');
  const root=range.commonAncestorContainer.nodeType===Node.TEXT_NODE
    ? range.commonAncestorContainer.parentNode
    : range.commonAncestorContainer;
  const nodes=[];
  const acceptNode=(node)=>{
    if(!node.nodeValue||!node.nodeValue.trim())return NodeFilter.FILTER_REJECT;
    if(!doc.contains(node))return NodeFilter.FILTER_REJECT;
    if(node.parentElement&&node.parentElement.closest('aside,.float'))return NodeFilter.FILTER_REJECT;
    try{return range.intersectsNode(node)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;}
    catch(e){return NodeFilter.FILTER_REJECT;}
  };
  if(root&&root.nodeType===Node.TEXT_NODE){
    if(acceptNode(root)===NodeFilter.FILTER_ACCEPT)nodes.push(root);
  }else if(root){
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode});
    while(walker.nextNode())nodes.push(walker.currentNode);
  }
  return nodes;
}

function highlightRange(range){
  const pieces=[];
  for(const node of textNodesInRange(range)){
    const value=node.nodeValue||'';
    let start=node===range.startContainer?range.startOffset:0;
    let end=node===range.endContainer?range.endOffset:value.length;
    start=Math.max(0,Math.min(start,value.length));
    end=Math.max(start,Math.min(end,value.length));
    if(start===end||!value.slice(start,end).trim())continue;
    pieces.push({node,start,end});
  }
  const spans=[];
  for(const p of pieces.reverse()){
    const selected=p.node.splitText(p.start);
    const after=selected.splitText(p.end-p.start);
    const span=document.createElement('span');
    span.className='hl';
    span.dataset.temp='true';
    selected.parentNode.insertBefore(span,after);
    span.appendChild(selected);
    spans.unshift(span);
  }
  return spans;
}

function nearestBlockText(span){
  let node=span.parentElement;
  while(node&&node.id!=='doc'&&!['P','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','DIV','TD','TH'].includes(node.tagName)){
    node=node.parentElement;
  }
  if(!node)return '';
  const clone=node.cloneNode(true);
  clone.querySelectorAll('.hl').forEach(el=>{
    const t=document.createTextNode(el.textContent);
    el.parentNode.replaceChild(t,el);
  });
  return clone.textContent.trim();
}

document.addEventListener('mousedown',e=>{
  if(floater&&!floater.contains(e.target))cancelDraft();
});

document.addEventListener('mouseup',e=>{
  if(e.target.closest('.float'))return;
  const sel=window.getSelection();
  const txt=sel.toString().trim();
  if(!txt){cancelDraft();return;}
  if(e.target.closest('aside'))return;
  try{
    const r=sel.getRangeAt(0);
    const rect=r.getBoundingClientRect();
    const spans=highlightRange(r);
    sel.removeAllRanges();
    if(!spans.length){cancelDraft();return;}
    const selectedText=(spans.map(s=>s.textContent||'').join(' ').replace(/\\s+/g,' ').trim())||txt;
    const firstRect=(spans[0]||document.body).getBoundingClientRect();
    const x=rect.left||firstRect.left;
    const y=rect.bottom||firstRect.bottom;
    const context=spans.length===1?nearestBlockText(spans[0]):selectedText;
    showFloater(x,y+6);
    draft={selectedText,context,spans,text:''};
  }catch(err){console.error('[Review] selection error',err);}
});

function showFloater(x,y){
  hideF();
  floater=document.createElement('div');
  floater.className='float';
  floater.style.left=Math.max(8,x)+'px';
  floater.style.top=Math.max(8,y)+'px';

  const ta=document.createElement('textarea');
  ta.placeholder='Type a note...';
  ta.addEventListener('keydown',e=>{
    e.stopPropagation();
    if(e.key==='Enter'&&!e.shiftKey&&!e.metaKey&&!e.ctrlKey){e.preventDefault();submitComment(ta.value.trim());}
    if(e.key==='Escape'){e.preventDefault();cancelDraft();}
  });
  ta.addEventListener('blur',e=>{
    setTimeout(()=>{if(floater&&!floater.contains(document.activeElement))cancelDraft();},50);
  });

  const row=document.createElement('div');
  row.className='row';

  const cancelBtn=document.createElement('button');
  cancelBtn.className='cancel';
  cancelBtn.textContent='Cancel';
  cancelBtn.onclick=()=>cancelDraft();

  const okBtn=document.createElement('button');
  okBtn.className='ok';
  okBtn.textContent='Add note';
  okBtn.onclick=()=>submitComment(ta.value.trim());

  row.appendChild(cancelBtn);
  row.appendChild(okBtn);
  floater.appendChild(ta);
  floater.appendChild(row);
  document.body.appendChild(floater);
  const maxX=Math.max(8,window.innerWidth-floater.offsetWidth-8);
  const maxY=Math.max(8,window.innerHeight-floater.offsetHeight-8);
  floater.style.left=Math.min(Math.max(8,x),maxX)+'px';
  floater.style.top=Math.min(Math.max(8,y),maxY)+'px';
  ta.focus();
}
function hideF(){if(floater){floater.remove();floater=null;}}

function submitComment(text){
  if(!draft)return;
  if(!text){cancelDraft();return;}
  const cid=nextId++;
  for(const span of draft.spans){
    span.removeAttribute('data-temp');
    span.dataset.hlid=String(cid);
  }
  comments.push({id:cid,selectedText:draft.selectedText,context:draft.context||'',text});
  draft=null;
  hideF();
  draw();
}

function draw(){
  const list=$('list');
  $('cnt').textContent=comments.length;
  list.innerHTML='';
  if(!comments.length){
    const empty=document.createElement('div');
    empty.className='empty';
    empty.textContent=pageOptions.emptyText;
    list.appendChild(empty);
    return;
  }
  for(const c of comments){
    const card=document.createElement('div');
    card.className='c';
    card.dataset.id=String(c.id);

    const q=document.createElement('div');
    q.className='q';
    q.textContent='\u201c'+c.selectedText+'\u201d';
    card.appendChild(q);

    const body=document.createElement('div');
    body.className='body';
    body.textContent=c.text;
    card.appendChild(body);

    const acts=document.createElement('div');
    acts.className='acts';

    const editBtn=document.createElement('button');
    editBtn.textContent='Edit';
    editBtn.className='primary';
    editBtn.onclick=()=>{
      body.innerHTML='';
      const ta=document.createElement('textarea');
      ta.value=c.text;
      ta.addEventListener('keydown',e=>{
        e.stopPropagation();
        if(e.key==='Enter'&&!e.shiftKey&&!e.metaKey&&!e.ctrlKey){e.preventDefault();c.text=ta.value.trim();draw();}
        if(e.key==='Escape'){e.preventDefault();draw();}
      });
      body.appendChild(ta);
      ta.focus();
      editBtn.textContent='Save';
      editBtn.onclick=()=>{c.text=ta.value.trim();draw();};
    };
    acts.appendChild(editBtn);

    const delBtn=document.createElement('button');
    delBtn.textContent='Delete';
    delBtn.style.cssText='background:transparent;color:var(--danger);border:1px solid var(--danger)!important;';
    delBtn.onclick=()=>{
      document.querySelectorAll('span[data-hlid="'+c.id+'"]').forEach(span=>unwrapHighlight(span));
      comments=comments.filter(x=>x.id!==c.id);
      draw();
    };
    acts.appendChild(delBtn);

    card.appendChild(acts);
    list.appendChild(card);
  }
}

function sendFromButton(btn){
  send(btn.dataset.action,pageOptions.defaultAction,btn.dataset.approved==='true',btn.dataset.done || 'Sent. Closing...');
}

function sendDefault(action){
  const btn=document.querySelector('button[data-action="'+action+'"]') || document.querySelector('button[data-action]');
  if(btn)sendFromButton(btn);
}

async function send(action,fallbackAction,approved,doneText){
  const finalAction=action||fallbackAction;
  const feedback=$('general').value.trim();
  const payload={nonce:pageOptions.nonce,action:finalAction,approved,feedback,comments:comments.filter(c=>c.text.trim())};
  document.querySelectorAll('button[data-action]').forEach(b=>b.disabled=true);
  $('load').style.display='block';
  try{
    const r=await fetch('/decision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(r.ok){
      const notice=document.createElement('div');
      notice.className='notice';
      notice.style.color='var(--success)';
      notice.textContent=doneText;
      $('foot').replaceChildren(notice);
      setTimeout(()=>{try{window.close();}catch(e){}},800);
    }else{throw new Error('status '+r.status);}
  }catch(e){
    console.error('[Review] fetch error',e);
    document.querySelectorAll('button[data-action]').forEach(b=>b.disabled=false);
    $('load').style.display='none';
    alert('Failed to send. Check console and try again.');
  }
}

document.getElementById('foot').addEventListener('click',e=>{
  const btn=e.target.closest('button[data-action]');
  if(!btn)return;
  sendFromButton(btn);
});

document.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();sendDefault(pageOptions.defaultAction);}
});

$('general').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&e.shiftKey){e.preventDefault();sendDefault(pageOptions.textareaShortcutAction);}
});
</script>
</body>
</html>`;
}

function startServer(content: string, options: ReviewPageOptions, colors: Record<string, string>, isLight: boolean): Promise<ReviewResult> {
	return new Promise((resolve, reject) => {
		let done = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let returnFocusApp: string | null = null;
		const nonce = randomBytes(16).toString("hex");

		const closeSoon = (finish: () => void) => {
			setTimeout(() => {
				server.closeAllConnections?.();
				server.close(finish);
			}, 150);
		};

		const server = createServer((req, res) => {
			if (req.method === "OPTIONS") { res.writeHead(403); res.end(); return; }
			if (req.method === "POST" && req.url === "/decision") {
				let body = "";
				req.on("data", (c) => {
					body += c;
					if (body.length > 1_000_000) req.destroy();
				});
				req.on("end", () => {
					if (done) {
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true, duplicate: true }));
						return;
					}
					try {
						const data = JSON.parse(body) as ReviewResult & { nonce?: string };
						if (data.nonce !== nonce) {
							res.writeHead(403, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ error: "bad nonce" }));
							return;
						}
						delete data.nonce;
						done = true;
						if (timeout) clearTimeout(timeout);
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true }), () => {
							focusApp(returnFocusApp);
							closeSoon(() => resolve(data));
						});
					} catch {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "bad json" }));
					}
				});
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(buildPage(content, options, colors, isLight, nonce));
		});
		server.once("error", (err) => {
			if (!done) {
				done = true;
				if (timeout) clearTimeout(timeout);
				reject(err);
			}
		});
		server.listen(0, "127.0.0.1", () => {
			void (async () => {
				try {
					const addr = server.address();
					if (!addr || typeof addr === "string") throw new Error("bind failed");
					returnFocusApp = await getFrontmostAppName();
					const url = `http://127.0.0.1:${addr.port}`;
					await openBrowser(url);
				} catch (err) {
					if (!done) {
						done = true;
						if (timeout) clearTimeout(timeout);
						server.closeAllConnections?.();
						server.close(() => reject(err instanceof Error ? err : new Error(String(err))));
					}
				}
			})();
		});
		timeout = setTimeout(() => {
			if (!done) {
				done = true;
				server.closeAllConnections?.();
				server.close(() => resolve({ action: options.defaultAction, approved: false, feedback: options.timeoutFeedback }));
			}
		}, 30 * 60 * 1000);
	});
}

// ── Extension ──────────────────────────────────────────────────────────

export default function plan(pi: ExtensionAPI): void {
	let currentPlanPath: string | null = null;

	function persist(): void {
		pi.appendEntry("plan", { currentPlanPath });
	}

	function formatCommentBullets(comments: PlanComment[] | undefined): string[] {
		if (!comments || comments.length === 0) return [];
		return comments.map((c) => {
			if (c.context && c.context !== c.selectedText) {
				return `- \u201c${c.selectedText}\u201d (in: \u201c${c.context}\u201d) \u2014 ${c.text}`;
			}
			return `- \u201c${c.selectedText}\u201d \u2014 ${c.text}`;
		});
	}

	function formatPlanFeedback(result: ReviewResult): string {
		const parts: string[] = [];
		const commentLines = formatCommentBullets(result.comments);
		if (commentLines.length > 0) {
			parts.push("## Inline comments\n");
			parts.push(...commentLines);
			parts.push("");
		}
		if (result.feedback) {
			parts.push("## General feedback\n");
			parts.push(result.feedback);
		}
		return parts.join("\n");
	}

	function formatMessageReference(found: AssistantTextResult): string {
		if (!found.entryId) return "assistant message opened with /markup";
		const shortId = found.entryId.slice(0, 8);
		const when = found.timestamp ? `, ${found.timestamp}` : "";
		return `assistant message ${shortId} (entryId: ${found.entryId}${when})`;
	}

	function formatLastReply(result: ReviewResult, found: AssistantTextResult): string {
		const parts: string[] = [];
		if (result.feedback?.trim()) parts.push(result.feedback.trim());

		const commentLines = formatCommentBullets(result.comments);
		if (commentLines.length > 0) {
			if (parts.length > 0) parts.push("");
			parts.push(`## Notes on ${formatMessageReference(found)}`);
			parts.push("");
			parts.push(...commentLines);
		}
		return parts.join("\n");
	}

	pi.registerCommand("plan-status", {
		description: "Show active plan path",
		handler: async (_args, ctx) => {
			if (currentPlanPath) ctx.ui.notify(`Plan: ${currentPlanPath}`, "info");
			else ctx.ui.notify("No active plan.", "info");
		},
	});

	function reviewLastAssistantMessage(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			ctx.ui.notify("/markup requires interactive mode", "error");
			return;
		}

		const found = findLastAssistantText(ctx.sessionManager.getBranch() as readonly unknown[]);
		if (!found) {
			ctx.ui.notify("No assistant messages found on this branch", "error");
			return;
		}
		if (found.incompleteReason) {
			ctx.ui.notify(`Last assistant message incomplete (${found.incompleteReason})`, "error");
			return;
		}
		if (!found.text.trim()) {
			ctx.ui.notify("Last assistant message has no text to review", "error");
			return;
		}

		const { colors, isLight } = loadTheme(ctx);
		try { ctx.ui.notify("Markup: opening last assistant message in browser…", "info"); } catch {}

		void startServer(found.text, LAST_REPLY_OPTIONS, colors, isLight)
			.then(async (result) => {
				const reply = formatLastReply(result, found).trim();
				if (!reply) {
					ctx.ui.notify("No reply captured.", "info");
					return;
				}

				let existing = "";
				try {
					const ui = ctx.ui as unknown as { getEditorText?: () => string | Promise<string> };
					existing = (await ui.getEditorText?.())?.trimEnd() ?? "";
				} catch { /* older UI APIs may not expose getEditorText */ }
				ctx.ui.setEditorText(existing ? `${existing}\n\n${reply}` : reply);
				ctx.ui.notify(existing ? "Appended reply to the editor. Review and send when ready." : "Loaded reply into the editor. Review and send when ready.", "info");
			})
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Markup review failed: ${msg}`, "error");
			});
	}

	pi.registerCommand("markup", {
		description: "Open the last assistant message in the browser markup UI",
		handler: (_args, ctx) => reviewLastAssistantMessage(ctx),
	});

	pi.registerTool({
		name: "submit_plan",
		label: "Submit Plan",
		description:
			"Submit a markdown plan file for user review. The user can highlight text, " +
			"add inline comments, and send feedback or approve. If feedback is sent, " +
			"revise the same file and call this tool again.",
		parameters: {
			type: "object",
			properties: {
				filePath: { type: "string", description: "Path to the markdown plan file (.md or .mdx). Relative paths are resolved against cwd; absolute paths are allowed." },
			},
			required: ["filePath"],
		},

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const inputPath = (params as { filePath?: string })?.filePath?.trim();
			if (!inputPath) return { content: [{ type: "text", text: "Error: submit_plan requires filePath." }] };
			const fullPath = resolveMarkdownPath(inputPath, ctx.cwd);
			if (!fullPath) {
				return { content: [{ type: "text", text: `Error: file must be .md/.mdx. Got: ${inputPath}` }] };
			}
			let content: string;
			try {
				if (!statSync(fullPath).isFile()) throw new Error("not a file");
				content = readFileSync(fullPath, "utf-8");
			} catch (err) {
				return { content: [{ type: "text", text: `Error reading ${inputPath}: ${err instanceof Error ? err.message : String(err)}` }] };
			}
			if (!content.trim()) return { content: [{ type: "text", text: `Error: ${inputPath} is empty.` }] };

			currentPlanPath = inputPath;
			persist();

			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: `Plan auto-approved (non-interactive): ${inputPath}` }] };
			}

			const { colors, isLight } = loadTheme(ctx);

			try { ctx.ui.notify("Plan: opening review in browser…", "info"); } catch {}

			let result: ReviewResult;
			try {
				result = await startServer(content, { ...PLAN_REVIEW_OPTIONS, sourceLabel: inputPath }, colors, isLight);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Browser review failed (${msg}). Proceeding with auto-approve.` }] };
			}

			const feedback = formatPlanFeedback(result);
			if (result.approved) {
				return {
					content: [{ type: "text", text: `Plan approved!\n\n${feedback}`.trim() }],
				};
			}
			const fb = feedback || "Plan needs revision. Please update and resubmit.";
			return { content: [{ type: "text", text: `Feedback on ${inputPath}:\n\n${fb}\n\nRevise and submit again.` }] };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries().filter(
			(e) => e.type === "custom" && (e as Record<string, unknown>).customType === "plan",
		);
		const last = entries.pop() as Record<string, unknown> | undefined;
		if (last?.data && typeof last.data === "object") {
			const data = last.data as Record<string, unknown>;
			if (typeof data.currentPlanPath === "string") currentPlanPath = data.currentPlanPath;
		}
	});
}
