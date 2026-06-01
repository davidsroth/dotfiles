/**
 * Slack MCP Client Extension for pi
 *
 * Bridges the korotovsky/slack-mcp-server (or any compatible stdio MCP server)
 * into pi by spawning it as a child process, performing the MCP handshake,
 * and registering each remote tool as a pi tool.
 *
 * Auth file (NOT stowed; per-machine secrets):
 *   ~/.pi/agent/slack-mcp.json
 *
 *   {
 *     "command": "npx",                                  // optional; defaults shown
 *     "args": ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
 *     "env": {
 *       "SLACK_MCP_XOXP_TOKEN": "xoxp-..."               // OR XOXB, OR XOXC+XOXD
 *     },
 *     "autoConnect": true,                               // connect at extension load
 *     "toolPrefix": "slack_",                            // prefix for registered tool names
 *     "requestTimeoutMs": 60000,                         // optional: per-tool-call timeout (default 60000)
 *     "requestTimeoutMsByTool": {                        // optional: per-upstream-tool overrides
 *       "conversations_unreads": 180000                  //   (slow over many channels)
 *     },
 *     "postProcess": {                                   // optional: trim/clean CSV output (default on)
 *       "dropColumns": ["Permalink", "AttachmentIDs", "HasMedia", "BotName", "Cursor"],
 *       "maxTextLength": 800,                            //   0 disables truncation
 *       "resolveMentions": true                          //   <@U…> -> @name
 *     },                                                 //   set "postProcess": false to disable entirely
 *     "disabledTools": ["usergroups_create", "users_search"]  // optional: skip these upstream tools
 *   }
 *
 * postProcess (CSV output cleanup): drops wide rarely-used columns, truncates
 * long Text blobs, and resolves <@U…>/<#C…> mentions to @name/#name. Dropping
 * `Cursor` preserves pagination via a `next_cursor: <value>` footer. Output that
 * doesn't parse as consistent CSV is passed through untouched. To recover a
 * dropped field (e.g. Permalink) set a custom `dropColumns` list omitting it,
 * or set `"postProcess": false` for fully raw upstream output.
 *
 * `disabledTools` matches against upstream tool names (without `toolPrefix`).
 * Use this to trim system-prompt token weight by hiding tools you never call.
 * Example: omit all usergroup management to drop ~30% of Slack's tool tokens:
 *   "disabledTools": ["usergroups_create", "usergroups_list", "usergroups_me",
 *                     "usergroups_update", "usergroups_users_update"]
 *
 * Commands:
 *   /slack                connect / show status / disconnect / restart
 *
 * LLM-callable tools (always present):
 *   slack_mcp_connect, slack_mcp_disconnect, slack_mcp_status, slack_mcp_call,
 *   slack_mcp_whoami (auth.test — returns the authenticated user_id; use
 *   `from:<user_id>` in searches since `from:@me` is unsupported by Slack)
 *
 * Plus every tool reported by the upstream MCP server (e.g. conversations_history,
 * channels_list, conversations_search_messages), each prefixed with `toolPrefix`.
 */

import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// =============================================================================
// Types
// =============================================================================

interface SlackMCPConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  autoConnect?: boolean;
  toolPrefix?: string;
  startupTimeoutMs?: number;
  /**
   * Per-tool-call timeout in ms (applies to every `tools/call`). Default 60000.
   * Raise this for slow tools like `conversations_unreads` over many channels.
   */
  requestTimeoutMs?: number;
  /**
   * Per-upstream-tool timeout overrides (without toolPrefix), e.g.
   * { "conversations_unreads": 180000 }. Falls back to `requestTimeoutMs`.
   */
  requestTimeoutMsByTool?: Record<string, number>;
  /**
   * CSV output post-processing (token-trimming + readability). `false` disables
   * entirely; an object overrides individual knobs. See PostProcessConfig.
   */
  postProcess?: PostProcessConfig | boolean;
  /** Upstream tool names (without toolPrefix) to skip when registering with pi. */
  disabledTools?: string[];
}

/**
 * Post-processing applied to upstream CSV tool output (conversations_history,
 * conversations_replies, conversations_search_messages, channels_list, ...).
 * Safety: if the output doesn't parse as consistent CSV, it's passed through
 * unchanged. Every transform is individually configurable and reversible.
 */
interface PostProcessConfig {
  /** Master switch. Default true. */
  enabled?: boolean;
  /**
   * CSV column names (header-row labels) to drop. Default drops the wide,
   * rarely-used columns. To keep e.g. Permalink, pass a list without it.
   * When `Cursor` is dropped, the last non-empty pagination cursor is
   * preserved as a `next_cursor: <value>` footer so pagination still works.
   */
  dropColumns?: string[];
  /** Truncate the `Text` column to this many chars (0 = no truncation). Default 800. */
  maxTextLength?: number;
  /** Resolve `<@U…>` / `<#C…>` mentions to @name / #name inline. Default true. */
  resolveMentions?: boolean;
}

interface ResolvedPostProcess {
  enabled: boolean;
  dropColumns: Set<string>;
  maxTextLength: number;
  resolveMentions: boolean;
}

interface ResolvedConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  toolPrefix: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  requestTimeoutMsByTool: Record<string, number>;
  postProcess: ResolvedPostProcess;
  /** Set of upstream tool names (without toolPrefix) to skip. */
  disabledTools: Set<string>;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

type ToolExecutionResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
};

type NotifyLevel = "info" | "error";
type NotifyFn = (message: string, type?: NotifyLevel) => void;

// =============================================================================
// Constants & defaults
// =============================================================================

const AUTH_FILE = join(process.env.HOME || homedir(), ".pi", "agent", "slack-mcp.json");

const DEFAULT_COMMAND = "npx";
const DEFAULT_ARGS = ["-y", "slack-mcp-server@latest", "--transport", "stdio"];
const DEFAULT_TOOL_PREFIX = "slack_";
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
// Default per-tool-call timeout. Overridable via the auth file's
// `requestTimeoutMs` (global) or `requestTimeoutMsByTool` (per upstream tool).
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// CSV post-processing defaults (see PostProcessConfig).
const DEFAULT_DROP_COLUMNS = ["Permalink", "AttachmentIDs", "HasMedia", "BotName", "Cursor"];
const DEFAULT_MAX_TEXT_LENGTH = 800;
// Max NEW users.info lookups per tool call when resolving bare <@U…> mentions.
// Inline `<@U…|name>` forms and already-cached IDs are free and uncapped.
const MENTION_LOOKUP_CAP = 25;

// How long to wait between graceful (stdin close + SIGTERM) and SIGKILL.
// Short on purpose: we'd rather kill cleanly than leak orphans if pi is
// torn down mid-disconnect (e.g. during reload).
const DISCONNECT_SIGKILL_DELAY_MS = 500;
// Overall ceiling on a disconnect — beyond this we stop waiting for the
// `exit` event and let the kernel reap whatever's left.
const DISCONNECT_HARD_TIMEOUT_MS = 2_000;

// Defense-in-depth: do NOT forward the parent's full env to the spawned
// npm/node/Go process tree. Only pass what npx + the slack-mcp-server
// actually need, plus anything explicitly in the auth file's `env` block.
// This keeps ANTHROPIC_API_KEY, CLAUDE_PERSONAL_ACCESS_TOKEN, etc. out of
// the child's `environ` (still visible to that user via `pgrep -fl` on macOS,
// which scans KERN_PROCARGS2 — argv + environ concatenated).
const ENV_ALLOWLIST: readonly string[] = [
  // Core unix
  "PATH", "HOME", "USER", "USERNAME", "LOGNAME", "SHELL",
  "TMPDIR", "TMP", "TEMP", "TERM",
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  // Node / nvm
  "NODE_PATH", "NODE_OPTIONS", "NVM_DIR", "NVM_BIN", "NVM_INC",
];
const ENV_ALLOWLIST_PREFIXES: readonly string[] = ["NPM_", "npm_", "SLACK_"];

function buildChildEnv(cfgEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST_PREFIXES.some((p) => key.startsWith(p))) out[key] = value;
  }
  // Caller-supplied env wins (e.g. SLACK_MCP_XOXP_TOKEN).
  for (const [k, v] of Object.entries(cfgEnv)) out[k] = v;
  return out;
}

// =============================================================================
// Child-process tracker + last-resort cleanup
// =============================================================================
//
// Why a module-level tracker, separate from the SharedEntry registry:
//
// 1. The orphan-leak we're guarding against happens when the pi process is
//    torn down BEFORE our async `disconnect()` finishes (e.g. during reload
//    or unexpected exit). At that point, `releaseClient` may have started
//    but the SIGTERM/SIGKILL timers haven't fired yet — the Node event loop
//    just stops.
// 2. `process.on("exit", ...)` handlers run synchronously at the very end
//    and can still call `process.kill(...)`. We use this as a last resort
//    to reap any still-tracked child PIDs.
// 3. Tracker is pinned to globalThis so jiti reimports of this file share
//    the same set, consistent with the SharedEntry registry above.

const TRACKED_CHILDREN_KEY = "__piSlackMCPTrackedChildren_v1__";
const EXIT_HOOK_KEY = "__piSlackMCPExitHookInstalled_v1__";

function trackedChildren(): Set<number> {
  const g = globalThis as Record<string, unknown>;
  let s = g[TRACKED_CHILDREN_KEY] as Set<number> | undefined;
  if (!s) {
    s = new Set();
    g[TRACKED_CHILDREN_KEY] = s;
  }
  return s;
}

function installExitHookOnce(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[EXIT_HOOK_KEY]) return;
  g[EXIT_HOOK_KEY] = true;
  // Synchronous-only: must not await. process.kill is sync.
  const reapAll = () => {
    const children = trackedChildren();
    for (const pid of children) {
      // Kill the whole process group first (we spawned with detached:true,
      // so npm + node + Go all share PGID=pid).
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      // Belt-and-suspenders: also signal the leader directly.
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    children.clear();
  };
  process.on("exit", reapAll);
  // Don't register SIGINT/SIGTERM handlers — pi installs its own and we
  // don't want to interfere. The 'exit' hook fires after pi's signal
  // handlers complete (or after natural process termination), which is the
  // correct point for last-resort cleanup.
}

/**
 * Collect descendant PIDs (any depth) of a given root PID via `ps`.
 * Used by killProcessTree as a fallback in case some grandchild has
 * escaped the parent's process group (e.g. via setsid). Best-effort:
 * returns [] on any ps error.
 */
function collectDescendants(rootPid: number): number[] {
  try {
    const out = execSync("ps -A -o pid=,ppid=", { encoding: "utf-8", timeout: 1000 });
    const children = new Map<number, number[]>();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push(pid);
    }
    const result: number[] = [];
    const stack = [rootPid];
    while (stack.length) {
      const p = stack.pop()!;
      const kids = children.get(p);
      if (!kids) continue;
      for (const k of kids) {
        result.push(k);
        stack.push(k);
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Kill a process group hard and fast. Used both on connect-failure cleanup
 * and as the final stage of disconnect. Idempotent.
 *
 * Strategy:
 *   1. SIGKILL the process group (npm + node + Go binary, since we spawned
 *      with detached:true so they share PGID).
 *   2. SIGKILL the leader pid directly (in case the leader has moved to a
 *      different PGID — rare but possible).
 *   3. Walk descendants via `ps` and SIGKILL each — catches any grandchild
 *      that called setsid() or otherwise escaped the original PGID.
 */
function killProcessTreeHard(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  for (const descendant of collectDescendants(pid)) {
    try { process.kill(descendant, "SIGKILL"); } catch { /* gone */ }
  }
}

// =============================================================================
// Config loading
// =============================================================================

function loadConfig(): SlackMCPConfig | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as SlackMCPConfig;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[slack-mcp] Failed to parse ${AUTH_FILE}: ${msg}`);
    return null;
  }
}

function resolveConfig(cfg: SlackMCPConfig | null): ResolvedConfig {
  return {
    command: cfg?.command || DEFAULT_COMMAND,
    args: cfg?.args ?? DEFAULT_ARGS,
    env: cfg?.env ?? {},
    toolPrefix: cfg?.toolPrefix ?? DEFAULT_TOOL_PREFIX,
    startupTimeoutMs: cfg?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    requestTimeoutMs: cfg?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    requestTimeoutMsByTool: cfg?.requestTimeoutMsByTool ?? {},
    postProcess: resolvePostProcess(cfg?.postProcess),
    disabledTools: new Set(cfg?.disabledTools ?? []),
  };
}

function resolvePostProcess(pp?: PostProcessConfig | boolean): ResolvedPostProcess {
  if (pp === false) {
    return { enabled: false, dropColumns: new Set(), maxTextLength: 0, resolveMentions: false };
  }
  const o = pp && typeof pp === "object" ? pp : {};
  return {
    enabled: o.enabled ?? true,
    dropColumns: new Set(o.dropColumns ?? DEFAULT_DROP_COLUMNS),
    maxTextLength: o.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    resolveMentions: o.resolveMentions ?? true,
  };
}

function hasAuthEnv(env: Record<string, string>): boolean {
  return Boolean(
    env.SLACK_MCP_XOXP_TOKEN ||
      env.SLACK_MCP_XOXB_TOKEN ||
      (env.SLACK_MCP_XOXC_TOKEN && env.SLACK_MCP_XOXD_TOKEN) ||
      // Allow falling back to the parent process env (e.g. exported in zshenv)
      process.env.SLACK_MCP_XOXP_TOKEN ||
      process.env.SLACK_MCP_XOXB_TOKEN ||
      (process.env.SLACK_MCP_XOXC_TOKEN && process.env.SLACK_MCP_XOXD_TOKEN),
  );
}

// =============================================================================
// Identity (auth.test) — powers the slack_mcp_whoami tool
// =============================================================================
//
// The upstream korotovsky server exposes no whoami/auth_test tool, so search
// modifiers like `from:@me` don't resolve and silently return zero rows.
// We call Slack's auth.test directly with the configured token to surface the
// authenticated user's ID (use `from:<user_id>` in searches). Result is cached
// per token so repeated calls are free.

interface SlackIdentity {
  ok: boolean;
  url?: string;
  team?: string;
  user?: string;
  team_id?: string;
  user_id?: string;
  error?: string;
}

const identityCache = new Map<string, SlackIdentity>();

function resolveSlackToken(env: Record<string, string>): { token: string; cookie?: string } | null {
  const xoxp = env.SLACK_MCP_XOXP_TOKEN || process.env.SLACK_MCP_XOXP_TOKEN;
  if (xoxp) return { token: xoxp };
  const xoxb = env.SLACK_MCP_XOXB_TOKEN || process.env.SLACK_MCP_XOXB_TOKEN;
  if (xoxb) return { token: xoxb };
  // Browser (stealth) tokens: xoxc is the Bearer, xoxd is the `d` cookie.
  const xoxc = env.SLACK_MCP_XOXC_TOKEN || process.env.SLACK_MCP_XOXC_TOKEN;
  const xoxd = env.SLACK_MCP_XOXD_TOKEN || process.env.SLACK_MCP_XOXD_TOKEN;
  if (xoxc && xoxd) return { token: xoxc, cookie: `d=${xoxd}` };
  return null;
}

async function slackAuthTest(env: Record<string, string>): Promise<SlackIdentity> {
  const creds = resolveSlackToken(env);
  if (!creds) return { ok: false, error: "no_token" };
  const cached = identityCache.get(creds.token);
  if (cached) return cached;
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (creds.cookie) headers.Cookie = creds.cookie;
    const resp = await fetch("https://slack.com/api/auth.test", { method: "POST", headers });
    const data = (await resp.json()) as SlackIdentity;
    if (data.ok) identityCache.set(creds.token, data);
    return data;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Best-effort user-name lookup (users.info), cached in userNameCache.
async function fetchUserName(userId: string, env: Record<string, string>): Promise<string | null> {
  const creds = resolveSlackToken(env);
  if (!creds) return null;
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${creds.token}` };
    if (creds.cookie) headers.Cookie = creds.cookie;
    const resp = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, { headers });
    const data = (await resp.json()) as {
      ok: boolean;
      user?: { name?: string; profile?: { display_name?: string; real_name?: string } };
    };
    if (!data.ok || !data.user) return null;
    const u = data.user;
    return u.profile?.display_name || u.profile?.real_name || u.name || null;
  } catch {
    return null;
  }
}

// =============================================================================
// CSV output post-processing (token-trimming + readability)
// =============================================================================
//
// The upstream korotovsky server emits wide RFC4180 CSV with several rarely-used
// columns and unresolved <@U…> mention IDs. We trim/resolve here, in the one
// chokepoint every tool call passes through (StdioMCPClient.callTool). Safety
// first: anything that doesn't parse as consistent CSV is returned untouched,
// and if no transform actually changed the data we return the ORIGINAL string
// (never re-serialize for nothing). All transforms are config-gated.

// id -> display name, accumulated across calls (seeded from CSV rows for free,
// topped up via bounded users.info lookups).
const userNameCache = new Map<string, string>();

function parseCSV(text: string): string[][] | null {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; continue; }
        inQuotes = false;
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; sawAny = true; continue; }
    if (c === ",") { row.push(field); field = ""; sawAny = true; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; sawAny = true; continue; }
    field += c;
    sawAny = true;
  }
  if (inQuotes) return null; // unterminated quote => malformed, bail to passthrough
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return sawAny ? rows : null;
}

function serializeCSV(rows: string[][]): string {
  const esc = (f: string) => (/[",\n\r]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f);
  return `${rows.map((r) => r.map(esc).join(",")).join("\n")}\n`;
}

// Resolve Slack mention tokens to readable names. Inline-name forms
// (`<@U123|name>`, `<#C123|name>`) are free; bare `<@U123>` are resolved via
// the shared cache, then via up to `budget.n` users.info lookups.
async function resolveMentions(text: string, env: Record<string, string>, budget: { n: number }): Promise<string> {
  let out = text.replace(/<@([UW][A-Z0-9]+)\|([^>]+)>/g, (_m, id: string, nm: string) => {
    if (!userNameCache.has(id)) userNameCache.set(id, nm);
    return `@${nm}`;
  });
  out = out.replace(/<#(C[A-Z0-9]+)\|([^>]+)>/g, (_m, _id: string, nm: string) => `#${nm}`);
  const bare = new Set<string>();
  for (const m of out.matchAll(/<@([UW][A-Z0-9]+)>/g)) {
    if (!userNameCache.has(m[1])) bare.add(m[1]);
  }
  for (const id of bare) {
    if (budget.n <= 0) break;
    const nm = await fetchUserName(id, env);
    budget.n--;
    if (nm) userNameCache.set(id, nm);
  }
  out = out.replace(/<@([UW][A-Z0-9]+)>/g, (full, id: string) =>
    userNameCache.has(id) ? `@${userNameCache.get(id)}` : full,
  );
  return out;
}

async function postProcessCsv(
  text: string,
  pp: ResolvedPostProcess,
  env: Record<string, string>,
): Promise<string> {
  if (!pp.enabled || !text) return text;
  try {
    const rows = parseCSV(text);
    if (!rows || rows.length < 2) return text; // need header + >= 1 data row
    const header = rows[0];
    if (header.length < 2) return text;
    const ncol = header.length;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].length !== ncol) return text; // ragged => not the CSV we expect
    }

    const textIdx = header.indexOf("Text");
    const cursorIdx = header.indexOf("Cursor");
    const userIdx = header.indexOf("UserID");
    const nameIdx = header.indexOf("UserName");
    const realIdx = header.indexOf("RealName");

    // Seed the name cache from the rows themselves (free coverage for authors).
    if (userIdx >= 0) {
      for (let i = 1; i < rows.length; i++) {
        const id = rows[i][userIdx];
        if (!id || userNameCache.has(id)) continue;
        const nm = (nameIdx >= 0 && rows[i][nameIdx]) || (realIdx >= 0 && rows[i][realIdx]) || "";
        if (nm) userNameCache.set(id, nm);
      }
    }

    // Capture the pagination cursor before we (maybe) drop the column.
    let nextCursor = "";
    if (cursorIdx >= 0) {
      for (let i = 1; i < rows.length; i++) if (rows[i][cursorIdx]) nextCursor = rows[i][cursorIdx];
    }

    let changed = false;

    if (textIdx >= 0 && (pp.resolveMentions || pp.maxTextLength > 0)) {
      const budget = { n: MENTION_LOOKUP_CAP };
      for (let i = 1; i < rows.length; i++) {
        const orig = rows[i][textIdx];
        if (!orig) continue;
        let t = orig;
        if (pp.resolveMentions) t = await resolveMentions(t, env, budget);
        if (pp.maxTextLength > 0 && t.length > pp.maxTextLength) {
          const extra = t.length - pp.maxTextLength;
          t = `${t.slice(0, pp.maxTextLength)}\u2026[+${extra} chars truncated]`;
        }
        if (t !== orig) { rows[i][textIdx] = t; changed = true; }
      }
    }

    const dropIdx = new Set<number>();
    header.forEach((h, idx) => { if (pp.dropColumns.has(h)) dropIdx.add(idx); });
    let outRows = rows;
    if (dropIdx.size > 0) {
      outRows = rows.map((r) => r.filter((_v, idx) => !dropIdx.has(idx)));
      changed = true;
    }

    if (!changed) return text; // nothing to do => keep upstream bytes verbatim

    let out = serializeCSV(outRows);
    if (cursorIdx >= 0 && dropIdx.has(cursorIdx) && nextCursor) {
      out += `next_cursor: ${nextCursor}\n`;
    }
    return out;
  } catch {
    return text; // never let post-processing break a tool result
  }
}

// =============================================================================
// Stdio MCP client
// =============================================================================

class StdioMCPClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private tools: MCPTool[] = [];
  private connected = false;
  // Per-tool-call timeout, populated from ResolvedConfig at connect() time.
  private requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  private requestTimeoutMsByTool: Record<string, number> = {};
  // CSV post-processing config + auth env, populated at connect() time.
  private postProcess: ResolvedPostProcess = resolvePostProcess(undefined);
  private authEnv: Record<string, string> = {};

  get isConnected(): boolean {
    return this.connected;
  }

  getTools(): MCPTool[] {
    return this.tools;
  }

  private killProcessGroup(child: ChildProcessWithoutNullStreams): void {
    const childPid = child.pid;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    if (childPid === undefined) return;
    // Fast and unconditional: connect-failure path doesn't need to be polite.
    killProcessTreeHard(childPid);
    trackedChildren().delete(childPid);
  }

  async connect(cfg: ResolvedConfig): Promise<void> {
    if (this.connected) return;
    this.requestTimeoutMs = cfg.requestTimeoutMs;
    this.requestTimeoutMsByTool = cfg.requestTimeoutMsByTool;
    this.postProcess = cfg.postProcess;
    this.authEnv = cfg.env;

    // Ensure the at-exit reaper is registered before we spawn anything.
    installExitHookOnce();

    const env = buildChildEnv(cfg.env);
    const child = spawn(cfg.command, cfg.args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Put the child in its own process group so we can SIGTERM/SIGKILL the
      // whole tree (npm exec -> node -> Go binary). Without this, killing the
      // top-level npm leaves the node and Go grandchildren orphaned.
      detached: true,
    });
    this.child = child;
    if (child.pid !== undefined) {
      trackedChildren().add(child.pid);
      // Best-effort: drop from the tracker when the immediate child exits.
      // (Grandchildren may outlive this event, hence the explicit kill in
      // disconnect() and the at-exit reaper.)
      child.once("exit", () => {
        if (child.pid !== undefined) trackedChildren().delete(child.pid);
      });
    }

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      // Surface server logs to the pi log, but suppress routine noise
      const trimmed = chunk.trim();
      if (!trimmed) return;
      // Skip npm warnings and verbose Slack MCP JSON info logs
      if (trimmed.startsWith("npm warn")) return;
      if (trimmed.startsWith('{"level":"info"')) return;
      if (trimmed.startsWith("[slack-mcp]")) return; // already tagged
      console.warn(`[slack-mcp] ${trimmed}`);
    });

    const exitPromise = new Promise<never>((_resolve, reject) => {
      child.once("exit", (code, signal) => {
        const err = new Error(`Slack MCP server exited (code=${code} signal=${signal ?? "none"})`);
        // Reject all pending requests
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        this.connected = false;
        this.child = null;
        reject(err);
      });
      child.once("error", (err) => {
        this.connected = false;
        this.child = null;
        reject(err);
      });
    });
    // Don't let the unhandled-rejection eat us if we've already resolved
    exitPromise.catch(() => {});

    try {
      // initialize
      const initResult = (await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-slack-mcp", version: "1.0.0" },
      }, cfg.startupTimeoutMs)) as { capabilities?: unknown; serverInfo?: { name?: string } } | undefined;

      // initialized notification
      this.notify("notifications/initialized", {});

      // discover tools
      const listResult = (await this.request("tools/list", {})) as { tools?: MCPTool[] } | undefined;
      this.tools = (listResult?.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));

      this.connected = true;
      void initResult; // silence unused
    } catch (error) {
      // Ensure the child process tree is killed so we don't leak orphans
      // every time the handshake fails or times out.
      this.killProcessGroup(child);
      this.child = null;
      throw error;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const timeoutMs = this.requestTimeoutMsByTool[name] ?? this.requestTimeoutMs;
    const result = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as
      | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      | undefined;

    if (!result) return "";
    const content = result.content;
    let text: string;
    if (Array.isArray(content)) {
      text = content.map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c))).join("\n");
    } else {
      text = JSON.stringify(result);
    }
    return this.postProcess.enabled ? postProcessCsv(text, this.postProcess, this.authEnv) : text;
  }

  async disconnect(): Promise<void> {
    if (!this.child) {
      this.connected = false;
      return;
    }
    const child = this.child;
    const childPid = child.pid;
    this.connected = false;
    this.tools = [];
    this.child = null;

    // Resolves when the immediate child (npm exec) exits. NOTE: this does
    // NOT guarantee grandchildren are dead — npm exec can exit on stdin
    // EOF leaving its node+Go descendants behind. That's why we ALWAYS run
    // killProcessTreeHard below, regardless of whether `exited` resolves.
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
    });

    // Stage 1: nudge the server to flush and exit cleanly.
    try { child.stdin.end(); } catch { /* ignore */ }
    // Stage 1.5: SIGTERM the entire process group immediately. Negative pid
    // targets the group leader's group, which works because we spawned with
    // detached:true so npm + node + Go all share PGID = child.pid.
    if (childPid !== undefined) {
      try { process.kill(-childPid, "SIGTERM"); } catch { /* already exited */ }
    }

    // Stage 2: hard SIGKILL after a short delay. We do this UNCONDITIONALLY
    // (not in a clearable timer that gets cancelled when `exited` resolves)
    // because npm exec exiting first leaves grandchildren orphaned. Without
    // an unconditional SIGKILL we leak entire process trees on every
    // disconnect.
    const sigkillTimer = setTimeout(() => {
      if (childPid !== undefined) killProcessTreeHard(childPid);
    }, DISCONNECT_SIGKILL_DELAY_MS);
    // Don't keep the event loop alive solely for this timer — we want pi to
    // be free to exit. The at-exit hook is the final safety net.
    sigkillTimer.unref?.();

    // Bound the wait: never block disconnect forever waiting for `exit`.
    const hardTimeoutTimer = setTimeout(() => { /* let the await give up */ }, DISCONNECT_HARD_TIMEOUT_MS);
    hardTimeoutTimer.unref?.();
    const hardTimeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), DISCONNECT_HARD_TIMEOUT_MS).unref?.();
    });

    try {
      const winner = await Promise.race([exited.then(() => "exited" as const), hardTimeout]);
      if (winner === "timeout" && childPid !== undefined) {
        // Force-kill on hard timeout and continue.
        killProcessTreeHard(childPid);
      }
    } finally {
      clearTimeout(sigkillTimer);
      clearTimeout(hardTimeoutTimer);
      // Belt-and-suspenders final reap. Idempotent: signals to already-dead
      // pids just throw ESRCH which we swallow.
      if (childPid !== undefined) {
        killProcessTreeHard(childPid);
        trackedChildren().delete(childPid);
      }
    }

    // Reject any leftover requests
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Disconnected"));
    }
    this.pending.clear();
  }

  // ---------------------------------------------------------------------------

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    // newline-delimited JSON-RPC framing
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch (error) {
        console.warn(`[slack-mcp] Invalid JSON from server: ${line}`);
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: JsonRpcResponse): void {
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // Server-initiated notification or unmatched response — ignore for now
  }

  private write(payload: object): void {
    if (!this.child) throw new Error("Not connected to MCP server");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch (error) {
      console.warn(`[slack-mcp] Failed to send notification ${method}: ${(error as Error).message}`);
    }
  }
}

// =============================================================================
// Shared client registry (cross-session)
// =============================================================================
//
// Why: pi-coding-agent loads extensions per session with jiti's moduleCache:
// false (see dist/core/extensions/loader.js loadExtensionModule). That means
// every parent+subagent pair re-evaluates this file from scratch, so any
// `const` at module scope is FRESH per session — no implicit sharing.
//
// We instead pin the registry on `globalThis` so it survives jiti re-imports
// and lets parent and subagents share a single `StdioMCPClient` (and therefore
// a single MCP child process) keyed by config. This solves two things at
// once:
//
//   1. Subagents see dynamic slack_* tools on turn 1 — when an instance loads
//      and finds an already-connected shared client, it registers dynamic
//      tools synchronously before its `bindExtensions` resolves, so
//      pi-subagents' getAllTools() snapshot picks them up.
//
//   2. N subagents no longer spawn N MCP child processes. Refcount tracks
//      who is using the shared client; the child dies when the last ref is
//      released.
//
// Concurrency: Node is single-threaded, so as long as `registry.set` happens
// synchronously *before* any `await`, two concurrent `acquireClient` calls
// can't both create a new entry — the second one finds the entry the first
// inserted. In-flight connects are deduped via `entry.pending` so multiple
// acquires await the same handshake promise.

// KNOWN LIMITATION: stale-class methods on `/reload`.
//
// `jiti.import` runs with `moduleCache: false` (see pi-coding-agent
// loader.js createExtensionRuntime), so every `/reload` creates a fresh
// `StdioMCPClient` class definition. But the SharedEntry pinned to
// `globalThis` below preserves the instance from whichever module load
// first created it. Methods on that instance (`connect`, `disconnect`,
// etc.) keep dispatching to the ORIGINAL class definition's closures
// — not the freshly-loaded version.
//
// Practical impact:
//   - Bug fixes in `StdioMCPClient` methods DON'T take effect on
//     `/reload`; they only take effect on a full `pi` process restart.
//   - Examples: the env-scrub (`buildChildEnv`) in `connect()` and the
//     hardened SIGKILL path in `disconnect()` are inert if the shared
//     instance was created by a pre-fix version of this file.
//
// Workaround: after substantive changes to this file, do a full `pi`
// restart (not just `/reload`). globalThis is then empty and the new
// class gets to run.
//
// Why we accept this: fully fixing it requires either eviction on
// stale `instanceof` mismatch (extra handshake on every reload, more
// code complexity), version-bumping this key on every class-shape
// change (manual + leaks old entries), or dropping shared-client
// pooling entirely (re-introduces the N-subagents = N-MCP-children
// fanout). For a personal dotfiles-grade extension, restart-on-edit
// is the right tradeoff.
const SHARED_REGISTRY_KEY = "__piSlackMCPSharedRegistry_v1__";

interface SharedEntry {
  client: StdioMCPClient;
  refs: number;
  /** In-flight connect promise; null once connected (or before first connect). */
  pending: Promise<void> | null;
}

function getSharedRegistry(): Map<string, SharedEntry> {
  const g = globalThis as Record<string, unknown>;
  let reg = g[SHARED_REGISTRY_KEY] as Map<string, SharedEntry> | undefined;
  if (!reg) {
    reg = new Map<string, SharedEntry>();
    g[SHARED_REGISTRY_KEY] = reg;
  }
  return reg;
}

/**
 * Stable key for ResolvedConfig — captures everything that determines which
 * MCP child process to spawn (command, args, env). toolPrefix is intentionally
 * excluded so two sessions with different pi-side prefixes can still share
 * the same upstream server.
 */
function configKey(cfg: ResolvedConfig): string {
  const envEntries = Object.entries(cfg.env).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ command: cfg.command, args: cfg.args, env: envEntries });
}

/**
 * Synchronously peek for a connected shared client matching this config.
 * Returns null if no entry exists or the entry isn't yet connected. Used by
 * the extension entry's sync fast-path to register dynamic tools BEFORE
 * bindExtensions resolves, so subagent snapshots see them on turn 1.
 */
function peekConnectedShared(cfg: ResolvedConfig): StdioMCPClient | null {
  const entry = getSharedRegistry().get(configKey(cfg));
  if (!entry || !entry.client.isConnected) return null;
  return entry.client;
}

/**
 * Synchronously take a ref on an existing entry. Caller must have already
 * verified via peekConnectedShared that the entry exists and is connected.
 * Returns true if the ref was taken, false if the entry vanished between
 * peek and acquire (shouldn't happen in single-threaded JS but defensive).
 */
function acquireExistingRef(cfg: ResolvedConfig, client: StdioMCPClient): boolean {
  const entry = getSharedRegistry().get(configKey(cfg));
  if (!entry || entry.client !== client) return false;
  entry.refs++;
  return true;
}

/**
 * Acquire (and connect if needed) a shared client for this config. Concurrent
 * callers dedupe against an in-flight handshake via entry.pending.
 */
async function acquireClient(cfg: ResolvedConfig): Promise<StdioMCPClient> {
  const reg = getSharedRegistry();
  const key = configKey(cfg);
  let entry = reg.get(key);
  if (!entry) {
    entry = { client: new StdioMCPClient(), refs: 0, pending: null };
    reg.set(key, entry); // synchronous insert before any await — race-safe
  }
  entry.refs++;
  if (!entry.client.isConnected && !entry.pending) {
    const e = entry;
    e.pending = (async () => {
      try {
        await e.client.connect(cfg);
      } finally {
        e.pending = null;
      }
    })();
  }
  if (entry.pending) {
    try {
      await entry.pending;
    } catch (error) {
      // Connect failed: back out our ref and drop the entry if we were the
      // only holder, so the next caller gets a fresh attempt.
      entry.refs--;
      if (entry.refs <= 0) reg.delete(key);
      throw error;
    }
  }
  return entry.client;
}

/**
 * Release a previously-acquired client. If refs reach 0, disconnect the
 * shared child process. Looking up by client identity makes double-release
 * a safe no-op.
 *
 * `force: true` bypasses refcount, disconnects immediately, and removes the
 * entry. Other holders' captured `client` references will report
 * `isConnected = false` on their next call — they'll see graceful tool
 * errors, not crashes.
 */
async function releaseClient(
  client: StdioMCPClient,
  options: { force?: boolean } = {},
): Promise<void> {
  const reg = getSharedRegistry();
  for (const [key, entry] of reg) {
    if (entry.client !== client) continue;
    if (options.force) {
      reg.delete(key);
      if (entry.client.isConnected) await entry.client.disconnect();
      return;
    }
    entry.refs--;
    if (entry.refs <= 0) {
      reg.delete(key);
      if (entry.client.isConnected) await entry.client.disconnect();
    }
    return;
  }
}

/** Number of sessions currently holding a ref on this client (>=1 if held). */
function sharedRefCount(client: StdioMCPClient): number {
  for (const entry of getSharedRegistry().values()) {
    if (entry.client === client) return entry.refs;
  }
  return 0;
}

// =============================================================================
// Pi tool wiring
// =============================================================================

function toolResult(tool: string, text: string, details: Record<string, unknown> = {}): ToolExecutionResult {
  return {
    content: [{ type: "text", text }],
    details: { tool, ...details },
  };
}

function toolError(tool: string, text: string, details: Record<string, unknown> = {}): ToolExecutionResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { tool, ...details },
  };
}

interface StatusDiagnostics {
  /** pi registry entries matching this Slack prefix (post registerTool). */
  registeredToolNames?: string[];
  /** Currently active pi tools matching this Slack prefix (sent to the model on provider requests). */
  activeToolNames?: string[];
}

function enabledSlackTools(client: StdioMCPClient | null, cfg: ResolvedConfig): MCPTool[] {
  return (client?.getTools() ?? []).filter((tool) => !cfg.disabledTools.has(tool.name));
}

function statusText(
  client: StdioMCPClient | null,
  cfg: ResolvedConfig,
  diagnostics: StatusDiagnostics = {},
): string {
  const upstreamTools = client?.getTools() ?? [];
  const enabledTools = enabledSlackTools(client, cfg);
  const disabledTools = upstreamTools.filter((tool) => cfg.disabledTools.has(tool.name));
  const auth = hasAuthEnv(cfg.env) ? "configured" : "MISSING (set SLACK_MCP_XOXP_TOKEN, XOXB, or XOXC+XOXD)";
  const refs = client ? sharedRefCount(client) : 0;
  const sharedNote =
    refs > 1
      ? ` (shared with ${refs - 1} other session${refs - 1 === 1 ? "" : "s"})`
      : "";
  const lines: string[] = [
    `Slack MCP Status:`,
    `- Connected: ${client?.isConnected ? `Yes${sharedNote}` : "No"}`,
    `- Auth file: ${existsSync(AUTH_FILE) ? AUTH_FILE : `${AUTH_FILE} (missing)`}`,
    `- Command: ${cfg.command} ${cfg.args.join(" ")}`,
    `- Auth: ${auth}`,
    `- Tool prefix: '${cfg.toolPrefix}'`,
    `- Upstream tools discovered: ${upstreamTools.length}`,
    `- Pi tools enabled by config: ${enabledTools.length}`,
  ];
  if (diagnostics.registeredToolNames) {
    lines.push(`- Pi tools registered in this session: ${diagnostics.registeredToolNames.length}`);
  }
  if (diagnostics.activeToolNames) {
    lines.push(`- Pi tools active in this session: ${diagnostics.activeToolNames.length}`);
  }
  if (enabledTools.length > 0) {
    lines.push("");
    lines.push("Enabled Slack tools:");
    for (const t of enabledTools) lines.push(`  - ${cfg.toolPrefix}${t.name}`);
  }
  if (disabledTools.length > 0) {
    lines.push("");
    lines.push("Disabled by config (discovered upstream but not registered as pi tools):");
    for (const t of disabledTools) lines.push(`  - ${cfg.toolPrefix}${t.name}`);
  }
  if (diagnostics.registeredToolNames && diagnostics.registeredToolNames.length > 0) {
    lines.push("");
    lines.push("Registered pi Slack tools:");
    for (const name of diagnostics.registeredToolNames) lines.push(`  - ${name}`);
  }
  if (!client?.isConnected) lines.push("\nRun /slack to connect.");
  return lines.join("\n");
}

// =============================================================================
// Extension entry point
// =============================================================================

export default async function slackMCPExtension(pi: ExtensionAPI): Promise<void> {
  let cfg: ResolvedConfig = resolveConfig(loadConfig());
  const registeredToolNames = new Set<string>();

  // Reference to the shared StdioMCPClient this session holds a ref on, or
  // null if not currently connected. May point to a client other sessions
  // are also using (e.g. parent + N subagents share one). Set by the sync
  // fast-path below, by doConnect, or by the slack_mcp_connect tool.
  let client: StdioMCPClient | null = null;

  const refreshConfig = (): ResolvedConfig => {
    cfg = resolveConfig(loadConfig());
    return cfg;
  };

  const notify = (message: string, type: NotifyLevel = "info") => {
    try {
      pi.events.emit("ui:notify", { message, type });
    } catch {
      console.log(`[slack-mcp] ${message}`);
    }
  };

  const registryDiagnostics = (): StatusDiagnostics => {
    try {
      const controlToolNames = new Set(["slack_mcp_connect", "slack_mcp_disconnect", "slack_mcp_call", "slack_mcp_status", "slack_mcp_whoami"]);
      const isSlackTool = (name: string) => name.startsWith(cfg.toolPrefix) && !controlToolNames.has(name);
      return {
        registeredToolNames: pi.getAllTools().map((t) => t.name).filter(isSlackTool).sort(),
        activeToolNames: pi.getActiveTools().filter(isSlackTool).sort(),
      };
    } catch {
      return {};
    }
  };

  const registerDynamicTools = (): number => {
    if (!client) return 0;
    let enabledCount = 0;
    const prefix = cfg.toolPrefix;
    // `pi.getAllTools()` is a throwing stub during extension factory execution
    // (see pi-coding-agent loader.js createExtensionRuntime: action methods are
    // wired only after the runner binds). The sync fast-path below calls
    // registerDynamicTools() at factory time, so we must not call it then.
    // After bindExtensions resolves, getAllTools() works normally.
    //
    // We fall back to our own `registeredToolNames` set, which is sufficient
    // for within-this-extension dedup. Cross-extension name collisions on
    // `${prefix}<upstream-tool>` are vanishingly unlikely given the slack_
    // prefix and would just shadow rather than throw.
    let known: Set<string>;
    try {
      known = new Set(pi.getAllTools().map((t) => t.name));
    } catch {
      known = new Set();
    }

    for (const tool of client.getTools()) {
      if (cfg.disabledTools.has(tool.name)) continue;
      enabledCount++;
      const piName = `${prefix}${tool.name}`;
      if (known.has(piName) || registeredToolNames.has(piName)) continue;

      const description = tool.description
        ? `[Slack MCP] ${tool.description}`
        : `[Slack MCP] Slack tool: ${tool.name}`;

      pi.registerTool({
        name: piName,
        label: `Slack: ${tool.name.replace(/_/g, " ")}`,
        description,
        // Pass the upstream JSON Schema through unchanged.
        parameters: Type.Unsafe(tool.inputSchema),
        async execute(_toolCallId, params) {
          // Re-check `client` each call: a /slack force-restart from another
          // session can drop our reference. The closure captures the outer
          // `let client`, so this reads the current value, not entry-time.
          if (!client || !client.isConnected) {
            return toolError(piName, "Not connected to Slack MCP. Run /slack to connect.");
          }
          try {
            const text = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>);
            return toolResult(piName, text || "", { upstreamTool: tool.name });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return toolError(piName, `Error calling ${tool.name}: ${msg}`, { upstreamTool: tool.name, error: msg });
          }
        },
      });
      registeredToolNames.add(piName);
    }
    return enabledCount;
  };

  const doConnect = async (
    n: NotifyFn,
  ): Promise<{ ok: true; tools: number; shared: boolean } | { ok: false; error: string }> => {
    const config = refreshConfig();
    if (!hasAuthEnv(config.env)) {
      return {
        ok: false,
        error: `No Slack auth tokens found. Create ${AUTH_FILE} with an "env" block containing SLACK_MCP_XOXP_TOKEN (or XOXB, or XOXC+XOXD).`,
      };
    }
    // If we already hold a ref (e.g. sync fast-path took one at entry), just
    // re-register dynamic tools in case the upstream tool list changed.
    if (client?.isConnected) {
      const registeredTools = registerDynamicTools();
      return { ok: true, tools: registeredTools, shared: sharedRefCount(client) > 1 };
    }
    const alreadyConnected = peekConnectedShared(config) !== null;
    if (!alreadyConnected) {
      n(`Spawning Slack MCP server (${config.command} ${config.args.join(" ")})...`);
    }
    try {
      client = await acquireClient(config);
      const registeredTools = registerDynamicTools();
      return { ok: true, tools: registeredTools, shared: sharedRefCount(client) > 1 };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: msg };
    }
  };

  // === Synchronous fast-path ===============================================
  // If a shared client is already connected for this config (e.g. the parent
  // session connected before spawning us), take a ref and register dynamic
  // tools NOW — synchronously, before this extension entry function returns.
  // That puts the dynamic slack_* tools in the registry before bindExtensions
  // resolves, so pi-subagents' getAllTools() snapshot picks them up on turn 1.
  //
  // We bypass `acquireClient` (which is async) because we need this to land
  // synchronously. Safe because we only call this when peek confirms the
  // entry exists AND is connected — no handshake to await.
  //
  // Gated on `autoConnect`: if the user explicitly set `autoConnect: false`,
  // they don't want Slack tools registered automatically in this session,
  // even if a sibling session has a shared connection alive. They can still
  // attach on demand via `/slack connect` or `slack_mcp_connect`.
  if (loadConfig()?.autoConnect !== false) {
    const existing = peekConnectedShared(cfg);
    if (existing && acquireExistingRef(cfg, existing)) {
      client = existing;
      registerDynamicTools();
    }
  }

  // /slack command -----------------------------------------------------------
  pi.registerCommand("slack", {
    description: "Connect/disconnect/restart the Slack MCP server, or show status",
    handler: async (_args, ctx) => {
      const uiNotify: NotifyFn = (message, type = "info") => ctx.ui.notify(message, type);

      if (!client?.isConnected) {
        const result = await doConnect(uiNotify);
        if (result.ok) {
          const sharedNote = result.shared ? " (joined shared session)" : "";
          ctx.ui.notify(`Connected to Slack MCP. ${result.tools} tools registered${sharedNote}.`, "info");
        } else {
          ctx.ui.notify(`Slack MCP connect failed: ${result.error}`, "error");
        }
        return;
      }

      const refs = sharedRefCount(client);
      const choice = await ctx.ui.select(statusText(client, cfg, registryDiagnostics()), ["Restart", "Disconnect", "Cancel"]);
      if (choice === "Disconnect") {
        const heldClient = client;
        client = null;
        await releaseClient(heldClient);
        ctx.ui.notify(
          refs > 1
            ? `Released this session's slot. ${refs - 1} other session(s) still using the shared connection.`
            : "Disconnected from Slack MCP.",
          "info",
        );
      } else if (choice === "Restart") {
        if (refs > 1) {
          ctx.ui.notify(
            `Force-restart will affect ${refs - 1} other session(s) — their slack_* calls will fail until they reconnect.`,
            "info",
          );
        }
        const heldClient = client;
        client = null;
        await releaseClient(heldClient, { force: true });
        const result = await doConnect(uiNotify);
        if (result.ok) ctx.ui.notify(`Reconnected. ${result.tools} tools.`, "info");
        else ctx.ui.notify(`Reconnect failed: ${result.error}`, "error");
      }
    },
  });

  // Always-on control tools -------------------------------------------------
  pi.registerTool({
    name: "slack_mcp_connect",
    label: "Slack MCP Connect",
    description: "Spawn the Slack MCP server, perform handshake, and register Slack tools",
    parameters: Type.Object({}),
    async execute() {
      if (client?.isConnected) {
        return toolResult(
          "slack_mcp_connect",
          `Already connected. ${enabledSlackTools(client, cfg).length} Slack tools registered with prefix '${cfg.toolPrefix}'.`,
        );
      }
      const result = await doConnect(notify);
      if (result.ok) {
        const sharedNote = result.shared ? " (joined shared session)" : "";
        return toolResult(
          "slack_mcp_connect",
          `Connected to Slack MCP. ${result.tools} tools registered with prefix '${cfg.toolPrefix}'${sharedNote}.`,
        );
      }
      return toolError("slack_mcp_connect", result.error);
    },
  });

  pi.registerTool({
    name: "slack_mcp_disconnect",
    label: "Slack MCP Disconnect",
    description: "Release this session's reference to the Slack MCP server (kills the child process if no other sessions are using it)",
    parameters: Type.Object({}),
    async execute() {
      if (!client) return toolResult("slack_mcp_disconnect", "Not connected.");
      const refs = sharedRefCount(client);
      const heldClient = client;
      client = null;
      await releaseClient(heldClient);
      const text =
        refs > 1
          ? `Released this session's slot. ${refs - 1} other session(s) still using the shared connection.`
          : "Disconnected from Slack MCP.";
      return toolResult("slack_mcp_disconnect", text, { wasShared: refs > 1, remainingRefs: Math.max(0, refs - 1) });
    },
  });

  pi.registerTool({
    name: "slack_mcp_call",
    label: "Slack MCP Call",
    description: "Call an upstream Slack MCP tool by name. Useful when dynamic slack_* tools were just registered but are not exposed in the current tool schema yet.",
    parameters: Type.Object({
      tool: Type.String({
        description: "Upstream Slack MCP tool name, with or without the configured prefix (for example: conversations_search_messages or slack_conversations_search_messages). If the tool schema in this session only exposes this field, you may append a JSON object after the name, e.g. 'slack_conversations_search_messages {\"search_query\":\"from:@me\"}'.",
      }),
      args: Type.Optional(Type.Record(Type.String(), Type.Any(), {
        description: "JSON arguments to pass to the upstream Slack MCP tool. Examples: {\"search_query\":\"weekly plan\"}, {\"channel_id\":\"#general\",\"limit\":\"20\"}, {\"channel_id\":\"#general\",\"thread_ts\":\"1234567890.123456\"}",
      })),
    }),
    async execute(_toolCallId, params) {
      const p = params as { tool?: unknown; args?: unknown; arguments?: unknown };
      let rawTool = String(p.tool ?? "").trim();
      if (!rawTool) return toolError("slack_mcp_call", "Missing required 'tool' parameter.");

      // Primary arg channel is `args`. We also keep accepting the old
      // `arguments` field for compatibility with early test sessions.
      let rawArgs = p.args ?? p.arguments ?? {};

      // Escape hatch for sessions whose already-sent tool schema only exposes
      // the `tool` string: allow `tool` to be `name { ...json args... }`.
      const inlineJson = rawTool.match(/^(\S+)\s+({[\s\S]*})$/);
      if (inlineJson && (rawArgs === undefined || (typeof rawArgs === "object" && rawArgs !== null && Object.keys(rawArgs as Record<string, unknown>).length === 0))) {
        rawTool = inlineJson[1];
        try {
          rawArgs = JSON.parse(inlineJson[2]) as Record<string, unknown>;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return toolError("slack_mcp_call", `Invalid inline JSON args after tool name: ${msg}`);
        }
      }

      if (typeof rawArgs === "string") {
        try {
          rawArgs = rawArgs.trim() ? JSON.parse(rawArgs) : {};
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return toolError("slack_mcp_call", `Invalid JSON in args string: ${msg}`);
        }
      }
      if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
        return toolError("slack_mcp_call", "args must be a JSON object.", { argsType: typeof rawArgs });
      }

      const result = client?.isConnected ? { ok: true as const } : await doConnect(notify);
      if (!result.ok) return toolError("slack_mcp_call", result.error);
      if (!client?.isConnected) return toolError("slack_mcp_call", "Not connected to Slack MCP.");

      const upstreamTool = rawTool.startsWith(cfg.toolPrefix) ? rawTool.slice(cfg.toolPrefix.length) : rawTool;
      if (cfg.disabledTools.has(upstreamTool)) {
        return toolError(
          "slack_mcp_call",
          `Slack tool '${cfg.toolPrefix}${upstreamTool}' is disabled by ${AUTH_FILE}. Remove it from disabledTools to call it.`,
          { upstreamTool },
        );
      }
      if (!client.getTools().some((tool) => tool.name === upstreamTool)) {
        const available = enabledSlackTools(client, cfg).map((tool) => `${cfg.toolPrefix}${tool.name}`);
        return toolError(
          "slack_mcp_call",
          `Unknown Slack MCP tool '${rawTool}'. Enabled tools: ${available.join(", ") || "(none)"}`,
          { upstreamTool, available },
        );
      }

      try {
        const args = rawArgs as Record<string, unknown>;
        const text = await client.callTool(upstreamTool, args);
        return toolResult("slack_mcp_call", text || "", { upstreamTool, calledAs: rawTool, args });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return toolError("slack_mcp_call", `Error calling ${upstreamTool}: ${msg}`, { upstreamTool, error: msg });
      }
    },
  });

  pi.registerTool({
    name: "slack_mcp_whoami",
    label: "Slack MCP Whoami",
    description:
      "Return the authenticated Slack user's identity (user_id, user, team, team_id, url) via auth.test. " +
      "Use the returned user_id with search modifiers like 'from:<user_id>' \u2014 the bare 'from:@me' " +
      "modifier is NOT supported by Slack search and silently returns zero results. No MCP connection required.",
    parameters: Type.Object({}),
    async execute() {
      const config = refreshConfig();
      if (!hasAuthEnv(config.env)) {
        return toolError("slack_mcp_whoami", `No Slack auth tokens found. Create ${AUTH_FILE} with a SLACK_MCP_XOXP_TOKEN (or XOXB, or XOXC+XOXD).`);
      }
      const id = await slackAuthTest(config.env);
      if (!id.ok) {
        return toolError("slack_mcp_whoami", `Slack auth.test failed: ${id.error ?? "unknown error"}`, { error: id.error });
      }
      const text = [
        `user_id: ${id.user_id}`,
        `user:    ${id.user}`,
        `team:    ${id.team} (${id.team_id})`,
        `url:     ${id.url}`,
        ``,
        `Tip: use 'from:${id.user_id}' (or 'to:${id.user_id}') in conversations_search_messages \u2014 'from:@me' does not work.`,
      ].join("\n");
      return toolResult("slack_mcp_whoami", text, {
        user_id: id.user_id,
        user: id.user,
        team: id.team,
        team_id: id.team_id,
        url: id.url,
      });
    },
  });

  pi.registerTool({
    name: "slack_mcp_status",
    label: "Slack MCP Status",
    description: "Check Slack MCP connection status and list available tools",
    parameters: Type.Object({}),
    async execute() {
      const refs = client ? sharedRefCount(client) : 0;
      const diagnostics = registryDiagnostics();
      return toolResult("slack_mcp_status", statusText(client, cfg, diagnostics), {
        connected: client?.isConnected ?? false,
        upstreamToolCount: client?.getTools().length ?? 0,
        enabledToolCount: enabledSlackTools(client, cfg).length,
        registeredToolCount: diagnostics.registeredToolNames?.length,
        activeToolCount: diagnostics.activeToolNames?.length,
        sharedRefs: refs,
      });
    },
  });

  // Clean shutdown when pi tears down ---------------------------------------
  // Releases this session's ref. If we were the last holder the underlying
  // child process is killed; if subagents (or another session) still hold
  // refs, the child stays alive for them.
  pi.on("session_shutdown", async () => {
    if (client) {
      const heldClient = client;
      client = null;
      await releaseClient(heldClient);
    }
  });

  // Optional auto-connect at startup (deferred so extension runtime is ready).
  // Skip if the sync fast-path already grabbed a ref — common case for
  // subagents whose parent had already connected.
  const rawCfg = loadConfig();
  if (!client && rawCfg?.autoConnect && hasAuthEnv(cfg.env)) {
    setTimeout(async () => {
      const result = await doConnect(notify);
      if (!result.ok) {
        console.warn(`[slack-mcp] autoConnect failed: ${result.error}`);
      }
    }, 0);
  }
}
