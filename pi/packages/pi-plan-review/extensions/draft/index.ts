/**
 * Draft — Browser review for short messages the agent has drafted on the user's
 * behalf (Slack replies, PR comments, email replies, etc.).
 *
 * Agent calls submit_draft({ text }) with a proposed message body.
 * Browser opens a focused review page with the draft loaded into an editable
 * textarea. The user picks one of two distinct actions:
 *
 *   1. Copy (⌘↵)        — text → clipboard; user posts it themselves.
 *                          Agent should NOT call any posting tool.
 *   2. Approve (⇧⌘↵)    — text returned to agent (no clipboard);
 *                          user is authorising the agent to post via
 *                          the appropriate channel-specific tool.
 *
 * If the user edited the draft, the word-level diff of original→final is
 * included in the tool result so the agent sees what changed directly.
 *
 * This tool itself never posts anywhere. It exists because we don't want
 * the agent posting on the user's behalf without explicit approval —
 * submit_draft is the explicit-approval channel.
 *
 * Design notes:
 *   - Two CTAs only (Copy / Approve). esc or tab-close → cancel.
 *   - No iterative "send feedback" loop. No editor manipulation.
 *   - No inline annotations — edit the textarea directly.
 *   - Word-level diff (LCS over tokens) in `git diff --word-diff` style.
 *   - Theme/server/browser helpers are duplicated from miniplan; extract to a
 *     shared `_review/` module once both extensions settle.
 */

import { exec, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────

type DraftAction = "copy" | "approve" | "cancel";

interface DraftResult {
	action: DraftAction;
	text?: string;       // final draft contents on copy/approve (incl. user edits)
	edited?: boolean;    // true iff text !== original after trimEnd()
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

// ── Diff (word-level, LCS-based) ────────────────────────────────

/**
 * Tokenize text into atoms: word runs, whitespace runs, or single non-word
 * non-space chars (punctuation). Punctuation is diffed independently of
 * adjacent words — e.g. "foo." → ["foo", "."] so removing a period doesn't
 * drag the surrounding word into the diff marker.
 */
function tokenize(s: string): string[] {
	return s.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

/**
 * Word-level diff of `a` vs `b` rendered in `git diff --word-diff` style:
 *   - unchanged text appears verbatim
 *   - removed runs wrapped as `{-...-}`
 *   - inserted runs wrapped as `{+...+}`
 *   - adjacent del/ins regions are always rendered as `{-old-}{+new+}`
 *     (dels first, never interleaved) so changes read as clean replacements.
 *
 * Returns an empty string if `a === b`.
 */
function wordDiff(a: string, b: string): string {
	if (a === b) return "";
	const at = tokenize(a);
	const bt = tokenize(b);
	const m = at.length;
	const n = bt.length;

	// LCS DP table
	const lcs: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			if (at[i] === bt[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1;
			else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	// Walk: stream of ops at token granularity
	type Op = { type: "eq" | "del" | "ins"; text: string };
	const ops: Op[] = [];
	let i = 0, j = 0;
	while (i < m && j < n) {
		if (at[i] === bt[j]) { ops.push({ type: "eq", text: at[i] }); i++; j++; }
		else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ type: "del", text: at[i] }); i++; }
		else { ops.push({ type: "ins", text: bt[j] }); j++; }
	}
	while (i < m) ops.push({ type: "del", text: at[i++] });
	while (j < n) ops.push({ type: "ins", text: bt[j++] });

	// Group consecutive non-eq ops, collecting del text + ins text separately
	// so each change block renders as `{-DEL-}{+INS+}` (dels always first).
	const out: string[] = [];
	let k = 0;
	while (k < ops.length) {
		if (ops[k].type === "eq") {
			out.push(ops[k].text);
			k++;
			continue;
		}
		let delText = "", insText = "";
		while (k < ops.length && ops[k].type !== "eq") {
			if (ops[k].type === "del") delText += ops[k].text;
			else insText += ops[k].text;
			k++;
		}
		if (delText) out.push(`{-${delText}-}`);
		if (insText) out.push(`{+${insText}+}`);
	}
	return out.join("");
}

// ── Theme helpers (copied from miniplan; extract to shared module later) ──

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
		console.log("[Draft] theme load failed:", e);
	}
	return { colors, isLight };
}

function buildCss(colors: Record<string, string>, isLight: boolean): string {
	const accent = colors.accent ?? (isLight ? "#2563eb" : "#60a5fa");
	const success = colors.success ?? (isLight ? "#16a34a" : "#22c55e");
	const border = colors.border ?? (isLight ? "#ddd" : "#444");
	const muted = colors.muted ?? (isLight ? "#666" : "#999");
	const pageBg = isLight ? "#faf9f7" : "#1a1a1a";
	const pageFg = isLight ? "#1a1a1a" : "#e8e6e3";
	const codeBg = isLight ? "#f3f3f3" : "#2a2a2a";

	return `
:root {
  --surface: ${pageBg};
  --surface-elevated: color-mix(in oklab, ${pageBg} 95%, ${pageFg});
  --text: ${pageFg};
  --text-muted: ${muted};
  --border: ${border};
  --code-bg: ${codeBg};

  --interactive: ${accent};
  --interactive-text: ${contrastText(accent)};
  --interactive-hover: color-mix(in oklab, var(--interactive) 80%, black);

  --success: ${success};
  --success-text: ${contrastText(success)};
  --success-hover: color-mix(in oklab, var(--success) 80%, black);
}

* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body {
  font-family: "Fira Code Nerd Font", "Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, "Courier New", monospace;
  background: var(--surface); color: var(--text); line-height: 1.6;
  display: flex; flex-direction: column;
  font-size: 14px;
}

header {
  padding: 20px 32px 12px;
  border-bottom: 1px solid var(--border);
}
header h1 {
  font-size: 1.15rem; font-weight: 700; letter-spacing: -0.01em;
  margin-bottom: .25em;
}
header .hint {
  color: var(--text-muted); font-size: .85rem;
}
header kbd {
  display: inline-block;
  padding: 1px 5px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: .78rem;
  margin: 0 1px;
}

main {
  flex: 1; display: flex; flex-direction: column;
  padding: 20px 32px; min-height: 0;
}

.label {
  font-size: .78rem; text-transform: uppercase; letter-spacing: .06em;
  color: var(--text-muted); font-weight: 700;
  display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: 6px;
}
.label .count { font-weight: 400; text-transform: none; letter-spacing: 0; }

#draft {
  flex: 1 1 auto;
  width: 100%; resize: none;
  font-family: inherit; font-size: .95rem; line-height: 1.6;
  padding: 14px 16px;
  background: var(--surface-elevated);
  color: var(--text);
  border: 1px solid var(--border); border-radius: 4px;
  outline: none;
}
#draft:focus { border-color: var(--interactive); }

footer {
  display: flex; gap: 10px; padding: 14px 32px 20px;
  border-top: 1px solid var(--border);
}
footer button {
  flex: 1; padding: 12px 14px;
  font-family: inherit; font-size: .95rem; font-weight: 600;
  border: none; border-radius: 4px; cursor: pointer;
  letter-spacing: -0.01em;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
}
footer button.copy { background: var(--success); color: var(--success-text); }
footer button.copy:hover { background: var(--success-hover); }
footer button.approve { background: var(--interactive); color: var(--interactive-text); }
footer button.approve:hover { background: var(--interactive-hover); }
footer button[disabled] { opacity: .55; cursor: not-allowed; }
footer button kbd {
  background: rgba(0,0,0,.18); border: none; color: inherit;
  padding: 1px 5px; border-radius: 3px; font-size: .78rem;
}

#status {
  display: none;
  text-align: center; padding: 14px;
  color: var(--success); font-weight: 600;
}
`;
}

// ── Browser / focus ────────────────────────────────────────────────────

async function openBrowser(url: string): Promise<void> {
	const cmd =
		process.platform === "darwin" ? `open "${url}"`
		: process.platform === "win32" ? `start "" "${url}"`
		: `xdg-open "${url}"`;
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

// ── Clipboard ──────────────────────────────────────────────────────────

async function pbcopy(text: string): Promise<void> {
	if (process.platform !== "darwin") throw new Error("pbcopy is macOS-only");
	await new Promise<void>((resolve, reject) => {
		const child = spawn("pbcopy");
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`pbcopy exited with code ${code}`));
		});
		child.stdin.write(text);
		child.stdin.end();
	});
}

// ── Review page ────────────────────────────────────────────────────────

function buildPage(text: string, colors: Record<string, string>, isLight: boolean, nonce: string): string {
	const css = buildCss(colors, isLight);
	const pageOptions = scriptJson({ nonce });
	const initialText = scriptJson(text);

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Cache-Control" content="no-store">
<title>Draft Review</title>
<style>${css}</style>
</head>
<body>
<header>
  <h1>Draft Review</h1>
  <div class="hint"><kbd>⌘</kbd><kbd>↵</kbd> copy to clipboard (you post) · <kbd>⇧</kbd><kbd>⌘</kbd><kbd>↵</kbd> approve (I post for you) · <kbd>esc</kbd> cancel</div>
</header>
<main>
  <div class="label"><span>Draft</span><span class="count" id="chars">0 chars</span></div>
  <textarea id="draft" spellcheck="true"></textarea>
</main>
<div id="status"></div>
<footer>
  <button id="copyBtn" class="copy" data-action="copy" data-done="Copied. Closing...">Copy &amp; Close <kbd>⌘↵</kbd></button>
  <button id="approveBtn" class="approve" data-action="approve" data-done="Approved. Closing...">Approve &amp; Post <kbd>⇧⌘↵</kbd></button>
</footer>

<script>
const pageOptions = ${pageOptions};
const initialText = ${initialText};
const $ = (id) => document.getElementById(id);

const draft = $('draft');
const chars = $('chars');
draft.value = initialText;
const updateChars = () => { chars.textContent = draft.value.length + ' chars'; };
updateChars();
draft.addEventListener('input', updateChars);

window.addEventListener('load', () => {
  draft.focus();
  draft.setSelectionRange(draft.value.length, draft.value.length);
});

let sent = false;

const actionButtons = () => document.querySelectorAll('footer button[data-action]');
function setButtonsDisabled(disabled) {
  actionButtons().forEach((b) => { b.disabled = disabled; });
}

async function send(action, doneText) {
  if (sent) return;
  // Disable buttons BEFORE flipping the sent flag so any synchronous error
  // here doesn't leave the page locked with sent=true and no way to retry.
  setButtonsDisabled(true);
  sent = true;
  const payload = {
    nonce: pageOptions.nonce,
    action,
    text: draft.value,
  };
  try {
    const r = await fetch('/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error('status ' + r.status);
    if (doneText) {
      const status = $('status');
      status.textContent = doneText;
      status.style.display = 'block';
    }
    setTimeout(() => { try { window.close(); } catch (e) {} }, 600);
  } catch (e) {
    console.error('[Draft] fetch error', e);
    sent = false;
    setButtonsDisabled(false);
    alert('Failed to send. Check console and try again.');
  }
}

// Visible error banner for any uncaught JS error. Without this, a regression
// like a stale element reference silently kills every action path and the
// user is stuck waiting on the pi tool call with no signal of what broke.
window.addEventListener('error', (ev) => {
  const msg = (ev && ev.message) || 'Unknown error';
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:10px 16px;background:var(--danger,#c33);color:#fff;font-weight:600;font-family:inherit;z-index:9999;';
  banner.textContent = 'submit_draft UI error: ' + msg + ' — press esc to cancel and resubmit.';
  document.body.appendChild(banner);
});
window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev && ev.reason;
  const msg = (reason && reason.message) || String(reason);
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:10px 16px;background:var(--danger,#c33);color:#fff;font-weight:600;font-family:inherit;z-index:9999;';
  banner.textContent = 'submit_draft UI error: ' + msg + ' — press esc to cancel and resubmit.';
  document.body.appendChild(banner);
});

function sendFromButton(btn) {
  send(btn.dataset.action, btn.dataset.done);
}
document.querySelectorAll('footer button[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => sendFromButton(btn));
});

// Keyboard shortcuts:
//   ⌘↵         → copy
//   ⇧⌘↵       → approve
//   esc        → cancel
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendFromButton(e.shiftKey ? $('approveBtn') : $('copyBtn'));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    send('cancel', '');
  }
});

// Best-effort cancel on tab close
window.addEventListener('beforeunload', () => {
  if (sent) return;
  try {
    const blob = new Blob([JSON.stringify({ nonce: pageOptions.nonce, action: 'cancel', text: draft.value })], { type: 'application/json' });
    navigator.sendBeacon('/decision', blob);
  } catch (e) {}
});
</script>
</body>
</html>`;
}

function startServer(text: string, colors: Record<string, string>, isLight: boolean): Promise<DraftResult> {
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
						const data = JSON.parse(body) as { nonce?: string; action?: DraftAction; text?: string };
						if (data.nonce !== nonce) {
							res.writeHead(403, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ error: "bad nonce" }));
							return;
						}
						const action: DraftAction =
							data.action === "approve" ? "approve" :
							data.action === "copy" ? "copy" :
							"cancel";
						const finalText = typeof data.text === "string" ? data.text : "";
						done = true;
						if (timeout) clearTimeout(timeout);
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true }), () => {
							focusApp(returnFocusApp);
							closeSoon(() => resolve({
								action,
								text: finalText,
								edited: action !== "cancel" && finalText.replace(/\s+$/, "") !== text.replace(/\s+$/, ""),
							}));
						});
					} catch {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "bad json" }));
					}
				});
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(buildPage(text, colors, isLight, nonce));
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
		// 30-min timeout → treat as cancel.
		timeout = setTimeout(() => {
			if (!done) {
				done = true;
				server.closeAllConnections?.();
				server.close(() => resolve({ action: "cancel" }));
			}
		}, 30 * 60 * 1000);
	});
}

// ── Extension ──────────────────────────────────────────────────────────

export default function draft(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "submit_draft",
		label: "Submit Draft",
		description:
			"Submit a drafted message (Slack reply, PR comment, email, DM, etc.) for user review. " +
			"The user can edit the text inline and then choose one of two actions: " +
			"COPY (⌘↵) sends the text to the macOS clipboard — the user will post it themselves, " +
			"so do NOT call any posting tool afterward. " +
			"APPROVE (⇧⌘↵) returns the final text to you without touching the clipboard — " +
			"the user is authorising you to post on their behalf, so call the appropriate " +
			"channel-specific posting tool (Slack, GitHub, email, etc.) with the final text. " +
			"If the user edited the draft, the word-level diff of original→final is included " +
			"in the result. This tool itself never posts anywhere. " +
			"Result shape: starts with 'COPY' or 'APPROVE' tag, optionally an 'Edits:' block, " +
			"and for APPROVE the 'Final text:' block. '(draft cancelled)' if the user cancels. " +
			"On clipboard failure during COPY the result is prefixed with '(clipboard copy failed: ...)'.",
		parameters: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "The proposed message body to be reviewed and approved by the user.",
				},
			},
			required: ["text"],
		},

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const text = (params as { text?: string })?.text;
			if (typeof text !== "string" || !text.trim()) {
				return { content: [{ type: "text", text: "Error: submit_draft requires a non-empty `text` parameter." }] };
			}

			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "Draft auto-approved (non-interactive). No clipboard write in headless mode." }] };
			}

			const { colors, isLight } = loadTheme(ctx);

			try { ctx.ui.notify("Draft: opening review in browser…", "info"); } catch { /* best-effort */ }

			let result: DraftResult;
			try {
				result = await startServer(text, colors, isLight);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Draft review failed (${msg}).` }] };
			}

			if (result.action === "cancel") {
				return { content: [{ type: "text", text: "(draft cancelled)" }] };
			}

			const finalText = (result.text ?? text).replace(/\s+$/, "");
			const originalText = text.replace(/\s+$/, "");
			const diff = result.edited ? wordDiff(originalText, finalText) : "";

			if (result.action === "copy") {
				let clipboardPrefix = "";
				try {
					await pbcopy(finalText);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					clipboardPrefix = `(clipboard copy failed: ${msg})\n\n`;
				}
				const body = result.edited
					? `COPY — user took the draft to clipboard with edits. They will post it themselves; do NOT call a posting tool.\n\nEdits:\n\n${diff || "(no diff)"}`
					: `COPY — user took the draft to clipboard, no edits. They will post it themselves; do NOT call a posting tool.`;
				return { content: [{ type: "text", text: `${clipboardPrefix}${body}` }] };
			}

			// action === "approve"
			const body = result.edited
				? `APPROVE — user approved the draft for you to post, with edits.\n\nEdits:\n\n${diff || "(no diff)"}\n\nFinal text:\n\n${finalText}\n\nCall the appropriate channel-specific posting tool now with the final text.`
				: `APPROVE — user approved the draft for you to post, no edits.\n\nFinal text:\n\n${finalText}\n\nCall the appropriate channel-specific posting tool now.`;
			return { content: [{ type: "text", text: body }] };
		},
	});
}
