/**
 * Plan — Lightweight plan review for pi.
 *
 * Agent calls submit_plan with a markdown file path.
 * User can run /markup to review the agent's last message.
 * Browser opens a clean review page: select text to annotate, reply, approve, or send feedback.
 * Inherits the active pi theme for colors.
 *
 * Theme/server/browser/markdown helpers are shared via ../_review and ./markdown.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { escapeHtml, scriptJson } from "../_review/html";
import { createReviewServer } from "../_review/server";
import { buildPalette, loadTheme, type Palette, rootVarsBlock } from "../_review/theme";
import { toolText } from "../_review/tool";
import { mdToHtml } from "./markdown";

// ── Types ──────────────────────────────────────────────────────────────

export interface PlanComment {
	id: number;
	selectedText: string;
	context?: string;
	text: string;
}

export type ReviewAction = "approve" | "send-feedback" | "reply" | "cancel";

export interface ReviewResult {
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

/**
 * Find the last *user-facing* assistant reply on the branch.
 *
 * pi sessions interleave three message roles: `user`, `assistant`, and
 * `toolResult`. Assistant turns come in two flavours:
 *   - `stopReason: "toolUse"` — intermediate turn that ends in a tool call.
 *     Its content may include `thinking`, `toolCall`, and sometimes a short
 *     `text` preamble ("let me check…"). These are NOT the real reply.
 *   - `stopReason: "stop"` — the actual final reply to the user.
 *
 * We walk entries backwards and accept only the most recent assistant turn
 * with `stopReason === "stop"`. Everything else — user messages, toolResult
 * entries, intermediate `toolUse` turns, non-`message` entries (model_change,
 * custom_message, etc.) — is skipped. If the agent is mid-action (the latest
 * assistant turn is still `toolUse`), we keep looking back for the previous
 * completed reply rather than erroring out.
 *
 * If we find a completed assistant turn but it has no text parts (e.g. an
 * empty/aborted reply), we report it as incomplete so the caller can show a
 * useful message.
 */
export function findLastAssistantText(branchEntries: readonly unknown[]): AssistantTextResult | null {
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
		// Skip intermediate tool-call turns — they aren't the final reply.
		if (msg.stopReason !== "stop") continue;

		const textParts = (msg.content ?? [])
			.filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text);
		if (textParts.length === 0) {
			return { text: "", entryId: entry.id, timestamp: entry.timestamp, incompleteReason: "no text" };
		}
		return { text: textParts.join("\n"), entryId: entry.id, timestamp: entry.timestamp };
	}
	return null;
}

// ── CSS ────────────────────────────────────────────────────────────────

function buildCss(palette: Palette): string {
	const extraVars =
		`  --hl: ${palette.hl};\n` +
		`  --side: 360px;\n` +
		`  --interactive-subtle: color-mix(in oklab, var(--interactive) 15%, var(--surface));\n` +
		`  --danger: ${palette.error};\n`;

	return `
${rootVarsBlock(palette, extraVars)}

* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  font-family: "Fira Code Nerd Font", "Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, "Courier New", monospace;
  background: var(--surface); color: var(--text); line-height: 1.65; display: flex;
  font-size: 14px;
}
main { flex: 1; min-width: 0; overflow-y: auto; padding: 32px 40px; }
main h1 { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.01em; border-bottom: 1px solid var(--border); padding-bottom: .35em; margin-bottom: .7em; }
main h2 { font-size: 1.15rem; font-weight: 700; letter-spacing: -0.01em; margin-top: 1.6em; margin-bottom: .4em; }
main h3 { font-size: 1.05rem; font-weight: 700; letter-spacing: -0.01em; margin-top: 1.3em; }
main p { margin: .6em 0; }
main a { color: var(--interactive); text-decoration: none; border-bottom: 1px solid var(--interactive-subtle); }
main a:hover { border-bottom-color: var(--interactive); }
main blockquote { border-left: 2px solid var(--border); margin: .8em 0; padding-left: 1em; color: var(--text-muted); }
main code { font-family: inherit; font-size: .92em; background: var(--code-bg); padding: .05em .3em; border-radius: 2px; }
main pre { background: var(--code-bg); padding: .9em; border-radius: 2px; overflow-x: auto; max-width: 100%; line-height: 1.5; margin: .7em 0; border: 1px solid var(--border); }
main pre code { padding: 0; background: none; white-space: pre; }
main pre[data-lang]::before { content: attr(data-lang); display: block; color: var(--text-muted); font-size: .76rem; margin-bottom: .4em; text-transform: uppercase; letter-spacing: .04em; }
main .mermaid-diagram { background: var(--code-bg); border: 1px solid var(--border); border-radius: 2px; margin: .8em 0; padding: .9em; overflow-x: auto; }
main .mermaid-diagram .mermaid { display: flex; justify-content: center; min-width: min-content; }
main .mermaid-diagram .mermaid svg { max-width: 100%; height: auto; }
main .mermaid-diagram details { margin-top: .65em; color: var(--text-muted); }
main .mermaid-diagram summary { cursor: pointer; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
main .mermaid-diagram details pre { margin-bottom: 0; }
main .mermaid-error { color: var(--danger); margin-bottom: .6em; font-size: .86rem; }
main ul, main ol { margin: .55em 0 .75em 1.45em; padding: 0; }
main li { margin: .25em 0; padding-left: .15em; }
main li > ul, main li > ol { margin-top: .2em; margin-bottom: .25em; margin-left: 1.25em; }
main li.task { list-style: none; margin-left: -1.25em; }
main li.task > ul, main li.task > ol { margin-left: 2.5em; }
main li.task .bx { user-select: none; color: var(--text-muted); margin-right: .45em; }
main li.task.done { color: var(--text-muted); }
main del { color: var(--text-muted); }
main table { width: 100%; border-collapse: collapse; margin: .9em 0; font-size: .92em; display: block; overflow-x: auto; }
main th, main td { border: 1px solid var(--border); padding: .35em .55em; text-align: left; vertical-align: top; }
main th { background: var(--code-bg); font-weight: 700; }
main hr { border: none; border-top: 1px solid var(--border); margin: 1.4em 0; }

.hl { background: var(--interactive-subtle); border-bottom: 2px solid var(--interactive); color: inherit; padding: 0 2px; border-radius: 1px; }
.path { color: var(--text-muted); font-size: .82rem; margin-bottom: 1.6em; }

aside { width: var(--side); flex-shrink: 0; min-width: 0; border-left: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; }
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
  position: fixed;
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px; background: var(--surface-elevated);
  border: 1px solid var(--border); border-radius: 2px;
  box-shadow: 0 4px 16px rgba(0,0,0,.2);
  width: min(280px, calc(100vw - 16px));
  max-width: calc(100vw - 16px);
  z-index: 100;
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

/* ── Narrow viewport: stack main + aside vertically, let body scroll ── */
@media (max-width: 960px) {
  html, body { height: auto; overflow: visible; }
  body { flex-direction: column; min-height: 100vh; }
  main { flex: 0 0 auto; padding: 18px 14px 24px; overflow-y: visible; }
  main h1 { font-size: 1.2rem; }
  main h2 { font-size: 1.05rem; }
  main h3 { font-size: 1rem; }
  .path { margin-bottom: 1em; }
  aside {
    width: 100%; flex: 0 0 auto;
    border-left: none; border-top: 1px solid var(--border);
  }
  aside header { padding: 10px 14px; }
  #list { flex: 0 0 auto; max-height: 40vh; padding: 10px 12px; }
  footer { padding: 10px; }
  footer textarea { min-height: 56px; }
}
`;
}

// ── Page options ─────────────────────────────────────────────────────────

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

// ── Decision parsing ─────────────────────────────────────────────────────

const VALID_ACTIONS = new Set<ReviewAction>(["approve", "send-feedback", "reply", "cancel"]);

function parseComments(raw: unknown): PlanComment[] {
	if (!Array.isArray(raw)) return [];
	const out: PlanComment[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const c = item as Record<string, unknown>;
		const selectedText = typeof c.selectedText === "string" ? c.selectedText : "";
		const text = typeof c.text === "string" ? c.text : "";
		if (!text.trim()) continue;
		out.push({
			id: typeof c.id === "number" ? c.id : out.length + 1,
			selectedText,
			context: typeof c.context === "string" ? c.context : undefined,
			text,
		});
	}
	return out;
}

/** Validate + normalize a posted review decision (nonce already verified). */
export function parseReviewDecision(data: Record<string, unknown>): ReviewResult {
	const rawAction = data.action;
	const action: ReviewAction | undefined =
		typeof rawAction === "string" && VALID_ACTIONS.has(rawAction as ReviewAction)
			? (rawAction as ReviewAction)
			: undefined;
	return {
		action,
		approved: data.approved === true,
		feedback: typeof data.feedback === "string" ? data.feedback : undefined,
		comments: parseComments(data.comments),
	};
}

// ── Page rendering ───────────────────────────────────────────────────────

const MERMAID_CDN_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

function mermaidHex(value: string, fallback: string): string {
	const raw = value.trim();
	const short = raw.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
	if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
	const long = raw.match(/^#[0-9a-f]{6}/i);
	return long ? long[0].toLowerCase() : fallback;
}

function buildMermaidThemeVariables(palette: Palette): Record<string, string> {
	const background = mermaidHex(palette.pageBg, palette.isLight ? "#faf9f7" : "#1a1a1a");
	const surface = mermaidHex(palette.codeBg, palette.isLight ? "#f3f3f3" : "#2a2a2a");
	const text = mermaidHex(palette.pageFg, palette.isLight ? "#1a1a1a" : "#e8e6e3");
	const border = mermaidHex(palette.border, palette.isLight ? "#dddddd" : "#444444");
	const muted = mermaidHex(palette.muted, palette.isLight ? "#666666" : "#999999");
	return {
		background,
		primaryColor: surface,
		primaryTextColor: text,
		primaryBorderColor: border,
		lineColor: muted,
		secondaryColor: background,
		tertiaryColor: surface,
		noteBkgColor: surface,
		noteTextColor: text,
		actorBkg: surface,
		actorBorder: border,
		actorTextColor: text,
	};
}

function buildMermaidScript(body: string, palette: Palette): string {
	if (!body.includes('class="mermaid"')) return "";
	const mermaidUrl = scriptJson(MERMAID_CDN_URL);
	const themeVariables = scriptJson(buildMermaidThemeVariables(palette));
	return `<script type="module">
const diagrams = Array.from(document.querySelectorAll('.mermaid-diagram .mermaid'));
if (diagrams.length) {
  try {
    const { default: mermaid } = await import(${mermaidUrl});
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        ...${themeVariables},
        fontFamily: getComputedStyle(document.body).fontFamily,
      },
      flowchart: { htmlLabels: false },
      sequence: { useMaxWidth: true },
    });
    await mermaid.run({ nodes: diagrams });
  } catch (err) {
    console.error('[Review] Mermaid render failed', err);
    for (const diagram of diagrams) {
      const figure = diagram.closest('.mermaid-diagram');
      if (!figure || figure.querySelector('.mermaid-error')) continue;
      const error = document.createElement('div');
      error.className = 'mermaid-error';
      error.textContent = 'Mermaid render failed: ' + (err && err.message ? err.message : String(err)) + '. Source is shown below.';
      figure.insertBefore(error, figure.firstChild);
    }
  }
}
</script>`;
}

function buildPage(content: string, options: ReviewPageOptions, palette: Palette, nonce: string): string {
	const body = mdToHtml(content);
	const mermaidScript = buildMermaidScript(body, palette);
	const css = buildCss(palette);
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
let sent=false;
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
  if(e.target.closest('.float,.mermaid-diagram'))return;
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
  if(sent)return;
  const finalAction=action||fallbackAction;
  const feedback=$('general').value.trim();
  const payload={nonce:pageOptions.nonce,action:finalAction,approved,feedback,comments:comments.filter(c=>c.text.trim())};
  sent=true;
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
    sent=false;
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

// Best-effort cancel on tab close so closing the window releases the agent
// immediately instead of blocking until the 30-minute timeout.
window.addEventListener('beforeunload',()=>{
  if(sent)return;
  try{
    const blob=new Blob([JSON.stringify({nonce:pageOptions.nonce,action:'cancel',approved:false,feedback:'',comments:[]})],{type:'application/json'});
    navigator.sendBeacon('/decision',blob);
  }catch(e){}
});
</script>
${mermaidScript}
</body>
</html>`;
}

// ── Result formatting (pure; exported for tests) ─────────────────────────

const MAX_CONTEXT_LEN = 240;

export function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1).trimEnd()}\u2026`;
}

/** Bullet form, used by the `submit_plan` feedback path only. */
function formatCommentBullets(comments: PlanComment[] | undefined): string[] {
	if (!comments || comments.length === 0) return [];
	return comments.map((c) => {
		if (c.context && c.context !== c.selectedText) {
			return `- \u201c${c.selectedText}\u201d (in: \u201c${truncate(c.context, MAX_CONTEXT_LEN)}\u201d) \u2014 ${c.text}`;
		}
		return `- \u201c${c.selectedText}\u201d \u2014 ${c.text}`;
	});
}

export function formatPlanFeedback(result: ReviewResult): string {
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

/** One inline note rendered as a markdown quote block + paragraph. */
function formatCommentBlock(c: PlanComment): string {
	const sel = c.selectedText.trim();
	const ctx = c.context?.trim() ?? "";
	const note = c.text.trim();
	const lines: string[] = [`> \u201c${sel}\u201d`];
	if (ctx && ctx !== sel) {
		lines.push(`> _in: \u201c${truncate(ctx, MAX_CONTEXT_LEN)}\u201d_`);
	}
	lines.push("");
	lines.push(note);
	return lines.join("\n");
}

/**
 * Format the captured /markup result as a user-message payload.
 *
 *   - 0 notes → just the typed reply (or empty, caller handles).
 *   - 1 note, no separate reply text → single compact
 *     `Re "sel": note` line, with `(in: "…")` only
 *     when the surrounding block differs from the selection.
 *   - otherwise → per-note quote blocks followed by the reply text
 *     (if any), separated by blank lines.
 *
 * No entryId, short-id, or timestamp — the agent already has the
 * previous assistant turn in context, and the heading was just noise.
 */
export function formatLastReply(result: ReviewResult): string {
	const feedback = result.feedback?.trim() ?? "";
	const comments = (result.comments ?? []).filter((c) => c.text.trim().length > 0);

	if (comments.length === 0) return feedback;

	if (comments.length === 1 && !feedback) {
		const c = comments[0];
		const sel = c.selectedText.trim();
		const ctx = c.context?.trim() ?? "";
		const note = c.text.trim();
		if (!ctx || ctx === sel) {
			return `Re \u201c${sel}\u201d: ${note}`;
		}
		return `Re \u201c${sel}\u201d (in: \u201c${truncate(ctx, MAX_CONTEXT_LEN)}\u201d): ${note}`;
	}

	const blocks: string[] = [];
	for (const c of comments) blocks.push(formatCommentBlock(c));
	if (feedback) blocks.push(feedback);
	return blocks.join("\n\n");
}

// ── Extension ──────────────────────────────────────────────────────────

export default function plan(pi: ExtensionAPI): void {
	let currentPlanPath: string | null = null;

	function persist(): void {
		pi.appendEntry("plan", { currentPlanPath });
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
		const palette = buildPalette(colors, isLight);

		void createReviewServer<ReviewResult>({
			renderPage: (nonce) => buildPage(found.text, LAST_REPLY_OPTIONS, palette, nonce),
			parseDecision: parseReviewDecision,
			onTimeout: () => ({ action: LAST_REPLY_OPTIONS.defaultAction, approved: false, feedback: LAST_REPLY_OPTIONS.timeoutFeedback }),
			onUrl: (url) => {
				try { ctx.ui.notify(`Markup: opening last assistant message in browser: ${url}`, "info"); } catch {}
			},
		})
			.then((result) => {
				if (result.action === "cancel") {
					ctx.ui.notify("Markup review dismissed.", "info");
					return;
				}
				const reply = formatLastReply(result).trim();
				if (!reply) {
					ctx.ui.notify("No reply captured.", "info");
					return;
				}

				// Send the captured reply as a fresh user message instead of
				// stuffing it into the editor. When the agent is mid-turn we
				// queue as a follow-up; otherwise it kicks off a new turn
				// immediately. Mirrors the pattern used in pi-btw.
				try {
					if (ctx.isIdle()) {
						pi.sendUserMessage(reply);
					} else {
						pi.sendUserMessage(reply, { deliverAs: "followUp" });
					}
					ctx.ui.notify(ctx.isIdle() ? "Reply sent." : "Reply queued as follow-up.", "info");
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Failed to send reply: ${msg}`, "error");
				}
			})
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Markup review failed: ${msg}`, "error");
			});
	}

	pi.registerCommand("markup", {
		description: "Open the last assistant message in the browser markup UI",
		handler: async (_args, ctx) => { reviewLastAssistantMessage(ctx); },
	});

	pi.registerTool({
		name: "submit_plan",
		label: "Submit Plan",
		description:
			"Submit a plan or design for the user to review and sign off on before you implement a " +
			"non-trivial change. Write the plan to a .md or .mdx file first, then call this tool with " +
			"that file's path. The user can highlight text to add inline comments and either approve " +
			"or send feedback; if feedback is sent, revise the same file and call this tool again.",
		parameters: {
			type: "object",
			properties: {
				filePath: { type: "string", description: "Path to the markdown plan file (.md or .mdx). The file must already exist — write the plan to it before calling. Relative paths are resolved against cwd; absolute paths are allowed." },
			},
			required: ["filePath"],
		},

		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const inputPath = (params as { filePath?: string })?.filePath?.trim();
			if (!inputPath) return toolText("Error: submit_plan requires filePath.");
			const fullPath = resolveMarkdownPath(inputPath, ctx.cwd);
			if (!fullPath) {
				return toolText(`Error: file must be .md/.mdx. Got: ${inputPath}`);
			}

			// Fail safe: the agent is expected to have written the plan first.
			// Don't silently scaffold a placeholder the user would then "approve".
			if (!statSync(fullPath, { throwIfNoEntry: false })?.isFile()) {
				return toolText(`Error: ${inputPath} does not exist. Write the plan to that file first, then call submit_plan.`);
			}
			let content: string;
			try {
				content = readFileSync(fullPath, "utf-8");
			} catch (err) {
				return toolText(`Error reading ${inputPath}: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (!content.trim()) return toolText(`Error: ${inputPath} is empty.`);

			currentPlanPath = inputPath;
			persist();

			if (!ctx.hasUI) {
				return toolText(`Plan auto-approved (non-interactive): ${inputPath}`);
			}

			const { colors, isLight } = loadTheme(ctx);
			const palette = buildPalette(colors, isLight);

			let result: ReviewResult;
			try {
				result = await createReviewServer<ReviewResult>({
					renderPage: (nonce) => buildPage(content, { ...PLAN_REVIEW_OPTIONS, sourceLabel: inputPath }, palette, nonce),
					parseDecision: parseReviewDecision,
					// Timeout = no decision → route to the feedback path (NOT approve).
					onTimeout: () => ({ action: "send-feedback", approved: false, feedback: PLAN_REVIEW_OPTIONS.timeoutFeedback }),
					onUrl: (url) => {
						try { ctx.ui.notify(`Plan: opening review in browser: ${url}`, "info"); } catch {}
					},
				});
			} catch (err) {
				// Fail safe: if review can't happen, do NOT approve. The agent
				// should treat this as "review unavailable" and not proceed.
				const msg = err instanceof Error ? err.message : String(err);
				return toolText(`Plan review unavailable (${msg}) — NOT approved. The browser review could not open; do not proceed. Try submit_plan again, or ask the user to review ${inputPath} directly.`);
			}

			if (result.action === "cancel") {
				return toolText(`Plan review dismissed (window closed) for ${inputPath} — NOT approved. Do not proceed; resubmit when ready for review.`);
			}

			const feedback = formatPlanFeedback(result);
			if (result.approved) {
				return toolText(`Plan approved!\n\n${feedback}`.trim());
			}
			const fb = feedback || "Plan needs revision. Please update and resubmit.";
			return toolText(`Feedback on ${inputPath}:\n\n${fb}\n\nRevise and submit again.`);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries().filter(
			(e) => e.type === "custom" && (e as unknown as Record<string, unknown>).customType === "plan",
		);
		const last = entries.pop() as Record<string, unknown> | undefined;
		if (last?.data && typeof last.data === "object") {
			const data = last.data as Record<string, unknown>;
			if (typeof data.currentPlanPath === "string") currentPlanPath = data.currentPlanPath;
		}
	});
}
