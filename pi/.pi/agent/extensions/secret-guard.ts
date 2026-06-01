/**
 * secret-guard.ts — redact secret-like strings from tool outputs.
 *
 * Subscribes to the `tool_result` event and rewrites the result `content`
 * (the text the LLM receives AND what the TUI renders) so API keys, tokens,
 * private keys, and `KEY = value` style credentials are replaced with a
 * placeholder before they can appear in the transcript or be sent upstream.
 *
 * Config (all optional), in increasing precedence:
 *   1. ~/.pi/agent/secret-guard.json   (global default, tracked in dotfiles)
 *   2. <cwd>/.pi/secret-guard.json     (project override)
 *
 *   {
 *     "enabled": true,
 *     "mode": "redact",            // "redact" = mask the secret | "block" = drop whole output
 *     "genericAssignments": true,  // also catch `api_key = ...`, `password: ...`
 *     "includePatternName": true,  // placeholder shows which rule matched
 *     "notify": true,              // toast when something is redacted
 *     "placeholder": "[REDACTED]",
 *     "extraPatterns": ["regex1", "regex2"],   // custom regexes (string, 'gi' flags added)
 *     "allowlist": ["literal-string-to-never-redact"]
 *   }
 *
 * Scope: scans text content blocks of tool results. Image blocks are left
 * alone. `user_bash` (`!`/`!!`) output is NOT covered — only LLM tool calls.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  TextContent,
  ImageContent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export interface SecretPattern {
  name: string;
  regex: RegExp;
  /** Build the replacement. Default masks the whole match. `groups` are capture groups. */
  render?: (placeholder: string, match: string, ...groups: string[]) => string;
}

/**
 * High-precision patterns for well-known secret formats. Ordered so more
 * specific rules run before broader ones. Each regex MUST be global (`g`).
 */
export const DEFAULT_PATTERNS: SecretPattern[] = [
  {
    name: "private-key",
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  // Anthropic / OpenAI style: sk-..., sk-ant-..., sk-proj-...
  { name: "openai-anthropic-key", regex: /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g },
  // Stripe
  { name: "stripe-key", regex: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // AWS access key id (AKIA / ASIA)
  { name: "aws-access-key-id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub tokens (classic + fine-grained PAT)
  { name: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { name: "github-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  // GitLab PAT
  { name: "gitlab-token", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  // Slack tokens
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Google API key
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Google OAuth client secret
  { name: "google-oauth-secret", regex: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g },
  // npm token
  { name: "npm-token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // JWT (header.payload.signature, base64url)
  {
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  // Bearer <token> — keep the "Bearer " label, mask the token
  {
    name: "bearer-token",
    regex: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
    render: (ph, _m, label) => `${label}${ph}`,
  },
];

/**
 * Generic `KEY <sep> VALUE` credential matcher. The key name must look
 * secret-ish; the value must be ≥6 non-space chars. Keeps the key + separator,
 * masks only the value (preserving surrounding quotes).
 *
 * Groups: 1=key, 2=separator(+quote-open), 3=quote-open, 4=value
 */
export const GENERIC_ASSIGNMENT: SecretPattern = {
  name: "credential-assignment",
  // The value class excludes `[` and `]` so it never re-matches a `[REDACTED:...]`
  // placeholder left by an earlier (more specific) pattern. Real secret values
  // do not contain square brackets.
  regex:
    /\b([A-Za-z0-9_.-]*(?:passwd|password|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|private[_-]?key|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["'`]?)([^\s"'`,;\[\]]{12,})\3/gi,
  render: (ph, _m, key, sep, quote) => `${key}${sep}${quote}${ph}${quote}`,
};

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export interface RedactOptions {
  patterns: SecretPattern[];
  generic: boolean;
  placeholder: string;
  includePatternName: boolean;
  allowlist: Set<string>;
}

export interface RedactResult {
  text: string;
  /** Count of redactions per pattern name. */
  hits: Record<string, number>;
}

function applyPattern(
  text: string,
  pattern: SecretPattern,
  opts: RedactOptions,
  hits: Record<string, number>,
): string {
  const ph = opts.includePatternName ? `[REDACTED:${pattern.name}]` : opts.placeholder;
  // Reset lastIndex defensively (patterns are module-level + global).
  pattern.regex.lastIndex = 0;
  return text.replace(pattern.regex, (match, ...rest) => {
    // rest = [...groups, offset, fullString, (groupsObject?)]
    const groups = rest.filter((r) => typeof r === "string") as string[];
    // Drop the trailing fullString that string-typed args include.
    if (groups.length > 0) groups.pop();

    // Allowlist: skip if the matched secret (or its value group) is allowlisted.
    if (opts.allowlist.size > 0) {
      const candidate = pattern.render ? groups[groups.length - 1] : match;
      if (candidate && opts.allowlist.has(candidate)) return match;
    }

    hits[pattern.name] = (hits[pattern.name] ?? 0) + 1;
    return pattern.render ? pattern.render(ph, match, ...groups) : ph;
  });
}

export function redactText(text: string, opts: RedactOptions): RedactResult {
  const hits: Record<string, number> = {};
  if (!text) return { text, hits };
  let out = text;
  for (const p of opts.patterns) out = applyPattern(out, p, opts, hits);
  if (opts.generic) out = applyPattern(out, GENERIC_ASSIGNMENT, opts, hits);
  return { text: out, hits };
}

type Block = TextContent | ImageContent;

export function redactContent(
  content: Block[],
  opts: RedactOptions,
): { content: Block[]; changed: boolean; totalHits: number; hits: Record<string, number> } {
  let changed = false;
  let totalHits = 0;
  const aggHits: Record<string, number> = {};
  const next = content.map((block) => {
    if ((block as TextContent).type !== "text") return block;
    const tb = block as TextContent;
    const { text, hits } = redactText(tb.text ?? "", opts);
    const blockHits = Object.values(hits).reduce((a, b) => a + b, 0);
    if (blockHits > 0) {
      changed = true;
      totalHits += blockHits;
      for (const [k, v] of Object.entries(hits)) aggHits[k] = (aggHits[k] ?? 0) + v;
      return { ...tb, text };
    }
    return block;
  });
  return { content: changed ? next : content, changed, totalHits, hits: aggHits };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SecretGuardConfig {
  enabled: boolean;
  mode: "redact" | "block";
  genericAssignments: boolean;
  includePatternName: boolean;
  notify: boolean;
  placeholder: string;
  extraPatterns: string[];
  allowlist: string[];
  /** Tools where mode:"block" applies; all others fall back to "redact". Default: ["bash"]. */
  blockTools: string[];
}

const DEFAULT_CONFIG: SecretGuardConfig = {
  enabled: true,
  mode: "redact",
  genericAssignments: true,
  includePatternName: true,
  notify: true,
  placeholder: "[REDACTED]",
  extraPatterns: [],
  allowlist: [],
  blockTools: ["bash"],
};

function readConfigFile(path: string): Partial<SecretGuardConfig> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!raw || typeof raw !== "object") return {};
    return raw as Partial<SecretGuardConfig>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[secret-guard] Ignoring malformed config at ${path}: ${reason}`);
    return {};
  }
}

export function loadConfig(cwd: string): SecretGuardConfig {
  const global = readConfigFile(join(getAgentDir(), "secret-guard.json"));
  const project = readConfigFile(join(cwd, ".pi", "secret-guard.json"));
  const merged = { ...DEFAULT_CONFIG, ...global, ...project };
  // Coerce/validate shape defensively.
  merged.mode = merged.mode === "block" ? "block" : "redact";
  merged.extraPatterns = Array.isArray(merged.extraPatterns) ? merged.extraPatterns : [];
  merged.allowlist = Array.isArray(merged.allowlist) ? merged.allowlist : [];
  merged.blockTools = Array.isArray(merged.blockTools) ? merged.blockTools : ["bash"];
  return merged;
}

export function buildRedactOptions(cfg: SecretGuardConfig): RedactOptions {
  const patterns = [...DEFAULT_PATTERNS];
  for (const src of cfg.extraPatterns) {
    try {
      patterns.push({ name: "custom", regex: new RegExp(src, "gi") });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[secret-guard] Ignoring invalid extraPattern /${src}/: ${reason}`);
    }
  }
  return {
    patterns,
    generic: cfg.genericAssignments,
    placeholder: cfg.placeholder,
    includePatternName: cfg.includePatternName,
    allowlist: new Set(cfg.allowlist),
  };
}

function summarizeHits(hits: Record<string, number>): string {
  return Object.entries(hits)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name}×${n}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx: ExtensionContext) => {
    let cfg: SecretGuardConfig;
    try {
      cfg = loadConfig(ctx.cwd);
    } catch {
      return; // fail open on config errors
    }
    if (!cfg.enabled) return;

    const content = event.content as Block[];
    if (!Array.isArray(content) || content.length === 0) return;

    let result: ReturnType<typeof redactContent>;
    try {
      result = redactContent(content, buildRedactOptions(cfg));
    } catch (err) {
      // Fail open but make the failure visible — a guard that silently
      // crashes is worse than one that warns it didn't run.
      console.warn(`[secret-guard] redaction error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (!result.changed) return;

    if (cfg.notify) {
      ctx.ui.notify(
        `[secret-guard] masked ${result.totalHits} secret-like string(s) in ${event.toolName} output (${summarizeHits(result.hits)})`,
        // Note: message uses `[secret-guard]` (not `secret-guard:`) to avoid triggering our
        // own generic-assignment pattern when this source file is read by an agent.
        "warning",
      );
    }

    if (cfg.mode === "block" && cfg.blockTools.includes(event.toolName)) {
      return {
        content: [
          {
            type: "text",
            text: `[secret-guard] Output suppressed: ${result.totalHits} secret-like string(s) detected (${summarizeHits(result.hits)}). Re-run with the secret removed, or adjust ~/.pi/agent/secret-guard.json.`,
          },
        ],
        isError: true,
      };
    }

    return { content: result.content };
  });
}
