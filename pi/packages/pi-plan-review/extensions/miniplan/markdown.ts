/**
 * Minimal Markdown → HTML renderer for the plan/markup review page.
 *
 * Supports headings, paragraphs, inline emphasis/code/links/strikethrough,
 * fenced + inline code, Mermaid fenced diagrams, blockquotes,
 * ordered/unordered/nested/task lists, tables, and horizontal rules. Not a full
 * CommonMark implementation — just enough to render agent-authored plans
 * faithfully.
 */

import { escapeHtml } from "../_review/html";

export function renderInline(md: string): string {
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
		// Function replacement: code content may contain `$&`, `$1`, etc. which a
		// string replacement would re-interpret (e.g. `arr[$&]` → mangled output).
		html = html.replace(`@@CODE${i}@@`, () => codeSpans[i] ?? "");
	}
	return html;
}

function isHr(line: string): boolean {
	return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function isFenceStart(line: string): RegExpMatchArray | null {
	return line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^`]*)\s*$/);
}

function isMermaidLang(lang: string): boolean {
	const normalized = lang.trim().toLowerCase();
	return normalized === "mermaid" || normalized === "mmd";
}

function renderMermaidBlock(source: string): string {
	const escaped = escapeHtml(source);
	return [
		'<figure class="mermaid-diagram">',
		`<div class="mermaid" role="img" aria-label="Mermaid diagram">${escaped}</div>`,
		"<details>",
		"<summary>Mermaid source</summary>",
		`<pre data-lang="mermaid"><code>${escaped}</code></pre>`,
		"</details>",
		"</figure>",
	].join("");
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

export function mdToHtml(md: string): string {
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
			const source = code.join("\n");
			if (isMermaidLang(lang)) {
				out.push(renderMermaidBlock(source));
			} else {
				const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
				out.push(`<pre${langAttr}><code>${escapeHtml(source)}</code></pre>`);
			}
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
