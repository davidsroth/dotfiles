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
 *   - Shared theme/server/browser/clipboard helpers live in ../_review.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { escapeHtml, scriptJson } from "../_review/html";
import { pbcopy } from "../_review/os";
import { createReviewServer } from "../_review/server";
import { buildPalette, loadTheme, type Palette, rootVarsBlock } from "../_review/theme";
import { toolText } from "../_review/tool";
import { wordDiff } from "./diff";

// ── Types ──────────────────────────────────────────────────────────────

type DraftAction = "copy" | "approve" | "cancel";

interface DraftResult {
	action: DraftAction;
	text?: string;       // final draft contents on copy/approve (incl. user edits)
	edited?: boolean;    // true iff text !== original after trimEnd()
}

// ── CSS ────────────────────────────────────────────────────────────────

function buildCss(palette: Palette): string {
	return `
${rootVarsBlock(palette)}

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

// ── Review page ────────────────────────────────────────────────────────

function buildPage(text: string, palette: Palette, nonce: string): string {
	const css = buildCss(palette);
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
function showErrorBanner(msg) {
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:10px 16px;background:var(--danger,#c33);color:#fff;font-weight:600;font-family:inherit;z-index:9999;';
  banner.textContent = 'submit_draft UI error: ' + msg + ' — press esc to cancel and resubmit.';
  document.body.appendChild(banner);
}
window.addEventListener('error', (ev) => showErrorBanner((ev && ev.message) || 'Unknown error'));
window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev && ev.reason;
  showErrorBanner((reason && reason.message) || String(reason));
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

/** Validate + normalize the posted draft decision. */
export function parseDraftDecision(data: Record<string, unknown>): DraftResult {
	const action: DraftAction =
		data.action === "approve" ? "approve" :
		data.action === "copy" ? "copy" :
		"cancel";
	const text = typeof data.text === "string" ? data.text : "";
	return { action, text };
}

// ── Extension ──────────────────────────────────────────────────────────

export default function draft(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "submit_draft",
		label: "Submit Draft",
		description:
			"Whenever you're about to send or post a message on the user's behalf (Slack reply, PR " +
			"comment, email, DM, etc.), route it through this tool instead of posting directly. " +
			"The user reviews and may edit the text, then chooses one of two outcomes: " +
			"COPY — the text goes to the user's clipboard and they post it themselves, so do NOT " +
			"call any posting tool afterward. " +
			"APPROVE — the final text is returned to you and the user is authorising you to post it, " +
			"so call the appropriate channel-specific posting tool (Slack, GitHub, email, etc.) with " +
			"that text. If the user edited the draft, a word-level diff of original→final is included " +
			"in the result. This tool itself never posts anywhere.",
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

		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const text = (params as { text?: string })?.text;
			if (typeof text !== "string" || !text.trim()) {
				return toolText("Error: submit_draft requires a non-empty `text` parameter.");
			}

			if (!ctx.hasUI) {
				return toolText("Draft auto-approved (non-interactive). No clipboard write in headless mode.");
			}

			const { colors, isLight } = loadTheme(ctx);
			const palette = buildPalette(colors, isLight);

			let result: DraftResult;
			try {
				result = await createReviewServer<DraftResult>({
					renderPage: (nonce) => buildPage(text, palette, nonce),
					parseDecision: parseDraftDecision,
					onTimeout: () => ({ action: "cancel" }),
					onUrl: (url) => {
						try { ctx.ui.notify(`Draft: opening review in browser: ${url}`, "info"); } catch { /* best-effort */ }
					},
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolText(`Draft review failed (${msg}).`);
			}

			if (result.action === "cancel") {
				return toolText("(draft cancelled)");
			}

			const finalText = (result.text ?? text).replace(/\s+$/, "");
			const originalText = text.replace(/\s+$/, "");
			const edited = finalText !== originalText;
			const diff = edited ? wordDiff(originalText, finalText) : "";

			if (result.action === "copy") {
				let clipboardPrefix = "";
				try {
					await pbcopy(finalText);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					clipboardPrefix = `(clipboard copy failed: ${msg})\n\n`;
				}
				const body = edited
					? `COPY — user took the draft to clipboard with edits. They will post it themselves; do NOT call a posting tool.\n\nEdits:\n\n${diff || "(no diff)"}`
					: `COPY — user took the draft to clipboard, no edits. They will post it themselves; do NOT call a posting tool.`;
				return toolText(`${clipboardPrefix}${body}`);
			}

			// action === "approve"
			const body = edited
				? `APPROVE — user approved the draft for you to post, with edits.\n\nEdits:\n\n${diff || "(no diff)"}\n\nFinal text:\n\n${finalText}\n\nCall the appropriate channel-specific posting tool now with the final text.`
				: `APPROVE — user approved the draft for you to post, no edits.\n\nFinal text:\n\n${finalText}\n\nCall the appropriate channel-specific posting tool now.`;
			return toolText(body);
		},
	});
}
