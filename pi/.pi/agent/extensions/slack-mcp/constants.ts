// =============================================================================
// Constants & defaults + child-env allowlist
// =============================================================================

import { homedir } from "node:os";
import { join } from "node:path";

export const AUTH_FILE = join(process.env.HOME || homedir(), ".pi", "agent", "slack-mcp.json");

export const DEFAULT_COMMAND = "npx";
export const DEFAULT_ARGS = ["-y", "slack-mcp-server@latest", "--transport", "stdio"];
export const DEFAULT_TOOL_PREFIX = "slack_";
export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
// Default per-tool-call timeout. Overridable via the auth file's
// `requestTimeoutMs` (global) or `requestTimeoutMsByTool` (per upstream tool).
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// CSV post-processing defaults (see PostProcessConfig).
export const DEFAULT_DROP_COLUMNS = ["Permalink", "AttachmentIDs", "HasMedia", "BotName", "Cursor"];
export const DEFAULT_MAX_TEXT_LENGTH = 2000;
// Upstream tools whose output has a Text column worth truncating. We expose the
// per-call `_maxTextLength` / `_raw` override args only on these (keeps schema
// token overhead off tools where it does nothing, e.g. channels_list).
export const MESSAGE_TEXT_TOOLS = new Set([
  "conversations_history",
  "conversations_replies",
  "conversations_search_messages",
]);
// Max NEW users.info lookups per tool call when resolving bare <@U…> mentions.
// Inline `<@U…|name>` forms and already-cached IDs are free and uncapped.
export const MENTION_LOOKUP_CAP = 25;

// How long to wait between graceful (stdin close + SIGTERM) and SIGKILL.
// Short on purpose: we'd rather kill cleanly than leak orphans if pi is
// torn down mid-disconnect (e.g. during reload).
export const DISCONNECT_SIGKILL_DELAY_MS = 500;
// Overall ceiling on a disconnect — beyond this we stop waiting for the
// `exit` event and let the kernel reap whatever's left.
export const DISCONNECT_HARD_TIMEOUT_MS = 2_000;

// Defense-in-depth: do NOT forward the parent's full env to the spawned
// npm/node/Go process tree. Only pass what npx + the slack-mcp-server
// actually need, plus anything explicitly in the auth file's `env` block.
// This keeps ANTHROPIC_API_KEY, CLAUDE_PERSONAL_ACCESS_TOKEN, etc. out of
// the child's `environ` (still visible to that user via `pgrep -fl` on macOS,
// which scans KERN_PROCARGS2 — argv + environ concatenated).
/** @internal exported for tests */
export const ENV_ALLOWLIST: readonly string[] = [
  // Core unix
  "PATH", "HOME", "USER", "USERNAME", "LOGNAME", "SHELL",
  "TMPDIR", "TMP", "TEMP", "TERM",
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  // Node / nvm
  "NODE_PATH", "NODE_OPTIONS", "NVM_DIR", "NVM_BIN", "NVM_INC",
];
/** @internal exported for tests */
export const ENV_ALLOWLIST_PREFIXES: readonly string[] = ["NPM_", "npm_", "SLACK_"];

export function buildChildEnv(cfgEnv: Record<string, string>): Record<string, string> {
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
