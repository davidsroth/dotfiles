/**
 * pi-notification — Desktop notifications for Pi events
 * Originally installed by `tlink install pi-notification`, then customized for
 * a nicer / more informative banner (terminal-notifier direct, with tlink fallback).
 *
 * Selected events: agent_end (pi finished a turn, waiting for input)
 *
 * Banner layout (terminal-notifier):
 *   title    →  Pi · <project>
 *   subtitle →  <git-branch|session> · <tmux loc> · <response time>
 *   message  →  one-line preview of pi's last reply
 *
 * Note: the duration is the response time for the just-finished prompt
 * (agent_start → agent_end), NOT how long the session has been running.
 * Clicking the banner jumps to the originating tmux pane via tmux:// deeplink.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const { execSync, spawn } = require("child_process");
const path = require("path");

// ── tmux context ──────────────────────────────────────────────────────────────
function tmuxContext(): { session: string; window: string; pane: string; term: string } {
  let session = "", window = "", pane = "", term = "";
  try {
    const q = (fmt: string) =>
      execSync(`tmux display-message -p "${fmt}" 2>/dev/null`, { encoding: "utf8" }).trim();
    session = q("#{session_name}");
    window = q("#{window_name}");
    pane = q("#{pane_index}");
    term = q("#{client_termtype}");
  } catch {
    session = "no-tmux";
    window = "0";
    pane = "0";
  }
  return { session, window, pane, term };
}

// ── helpers ─────────────────────────────────────────────────────────────────
function gitBranch(cwd: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
      encoding: "utf8",
      cwd,
    }).trim();
  } catch {
    return "";
  }
}

function lastAssistantText(messages: any[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join(" ");
      if (text) return text;
    }
  }
  return "";
}

// Strip Markdown to clean plain text for a notification banner.
// macOS notifications render no rich formatting, so we remove markup and
// keep the readable text (e.g. link text without the URL, code without backticks).
function stripMarkdown(s: string): string {
  let t = s || "";
  // Fenced code blocks -> keep inner code, drop the ``` fences and language tag.
  t = t.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) => code);
  // Inline code `x` -> x
  t = t.replace(/`([^`]+)`/g, "$1");
  // Images ![alt](url) -> alt
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links [text](url) -> text
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Reference-style links [text][ref] -> text
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  // Bold/italic/strikethrough markers (**, __, *, _, ~~)
  t = t.replace(/(\*\*|__)(.*?)\1/g, "$2");
  t = t.replace(/(\*|_)(.*?)\1/g, "$2");
  t = t.replace(/~~(.*?)~~/g, "$1");
  // Headers (leading #), blockquotes (leading >)
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  t = t.replace(/^\s{0,3}>\s?/gm, "");
  // List markers: -, *, + and ordered "1." at line start -> bullet
  t = t.replace(/^\s*([-*+]|\d+\.)\s+/gm, "• ");
  // Horizontal rules
  t = t.replace(/^\s*([-*_])\1{2,}\s*$/gm, "");
  // Escaped markdown chars (\* \_ etc.)
  t = t.replace(/\\([\\`*_{}\[\]()#+\-.!~>])/g, "$1");
  return t;
}

function oneLine(s: string, max = 140): string {
  const flat = stripMarkdown(s || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

function fmtDuration(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m${rem}s` : `${m}m`;
}

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// ── notification dispatch ─────────────────────────────────────────────────────
function notify(title: string, subtitle: string, message: string, ctxInfo: { session: string; window: string; pane: string; term: string }): void {
  const { session, window, pane, term } = ctxInfo;
  const termName = (term || "").split(/\s+/)[0] || "";
  const deeplink = termName
    ? `tmux://${session}/${window}/${pane}?term=${percentEncode(termName)}`
    : `tmux://${session}/${window}/${pane}`;

  // Prefer terminal-notifier directly for full control over title/subtitle/message.
  try {
    execSync("command -v terminal-notifier >/dev/null 2>&1");
    const args = [
      "-title", title,
      "-subtitle", subtitle,
      "-message", message || "Ready for input",
      "-group", `pi-${session}`,
      "-sound", "Glass",
      "-open", deeplink,
    ];
    const child = spawn("terminal-notifier", args, { stdio: ["ignore", "ignore", "ignore"], detached: true });
    child.unref();
    return;
  } catch {
    // terminal-notifier not available — fall back to `tlink notify`.
  }

  try {
    const payload = JSON.stringify({
      source: "pi",
      event: "agent_end",
      message: message || "Ready for input",
    });
    const child = spawn(
      "tlink",
      ["notify", "--session", session, "--window", window, "--pane", pane, "--term", termName],
      { stdio: ["pipe", "ignore", "ignore"], detached: true }
    );
    child.stdin.write(payload);
    child.stdin.end();
    child.unref();
  } catch {
    /* give up silently — never break the turn */
  }
}

// ── extension ─────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  let turnStartedAt = 0;

  pi.on("agent_start", async (_event, _ctx) => {
    turnStartedAt = Date.now();
  });

  pi.on("agent_end", async (event, ctx) => {
    try {
      const tmux = tmuxContext();

      const cwd: string = (ctx as any)?.cwd || process.cwd();
      const project = path.basename(cwd) || "pi";

      const branch = gitBranch(cwd);
      const loc = `${tmux.session}:${tmux.window}.${tmux.pane}`;
      const duration = turnStartedAt ? fmtDuration(Date.now() - turnStartedAt) : "";

      const subtitleParts = [branch || tmux.session, loc, duration].filter(Boolean);

      const preview = oneLine(lastAssistantText((event as any)?.messages)) || "Ready for input";

      const title = `Pi · ${project}`;
      const subtitle = subtitleParts.join(" · ");

      notify(title, subtitle, preview, tmux);
    } catch {
      // Last-resort: minimal notification so a failure here never breaks pi.
      try {
        const tmux = tmuxContext();
        notify("Pi", "Ready for input", "Ready for input", tmux);
      } catch {
        /* swallow */
      }
    } finally {
      turnStartedAt = 0;
    }
  });
}
