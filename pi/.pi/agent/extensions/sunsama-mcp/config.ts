// =============================================================================
// Config loading for the Sunsama MCP extension
// =============================================================================

import { existsSync, readFileSync } from "node:fs";
import {
  CLAUDE_CODE_CONFIG_FILE,
  CONFIG_FILE,
  DEFAULT_CLAUDE_MCP_SERVER_NAME,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_TOOL_PREFIX,
  DEFAULT_URL,
} from "./constants";
import type { ResolvedConfig, SunsamaMCPConfig } from "./types";

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[sunsama-mcp] Ignoring malformed JSON at ${path}: ${msg}`);
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function loadConfig(): SunsamaMCPConfig | undefined {
  const raw = asRecord(readJson(CONFIG_FILE));
  if (!raw) return undefined;
  return raw as SunsamaMCPConfig;
}

function loadClaudeAuthorization(serverName: string): string | undefined {
  const raw = asRecord(readJson(CLAUDE_CODE_CONFIG_FILE));
  const servers = asRecord(raw?.mcpServers);
  const server = asRecord(servers?.[serverName]);
  const headers = stringRecord(server?.headers);
  return headers?.Authorization || headers?.authorization;
}

function resolveAuth(raw: SunsamaMCPConfig): { headers: Record<string, string>; source: ResolvedConfig["authSource"] } {
  const rawHeaders = stringRecord(raw.headers) ?? {};
  const envAuth = process.env.SUNSAMA_MCP_AUTHORIZATION ||
    (process.env.SUNSAMA_MCP_BEARER_TOKEN ? `Bearer ${process.env.SUNSAMA_MCP_BEARER_TOKEN}` : undefined);
  if (envAuth) return { headers: { ...rawHeaders, Authorization: envAuth }, source: "env" };

  const configuredAuth = rawHeaders.Authorization || rawHeaders.authorization || raw.authorization;
  if (configuredAuth) return { headers: { ...rawHeaders, Authorization: configuredAuth }, source: "pi-config" };

  const claudeAuth = loadClaudeAuthorization(raw.claudeMcpServerName ?? DEFAULT_CLAUDE_MCP_SERVER_NAME);
  if (claudeAuth) return { headers: { ...rawHeaders, Authorization: claudeAuth }, source: "claude-code" };

  return { headers: rawHeaders, source: "missing" };
}

export function resolveConfig(raw: SunsamaMCPConfig | undefined): ResolvedConfig {
  const cfg = raw ?? {};
  const auth = resolveAuth(cfg);
  return {
    url: cfg.url ?? DEFAULT_URL,
    headers: auth.headers,
    toolPrefix: cfg.toolPrefix ?? DEFAULT_TOOL_PREFIX,
    autoConnect: cfg.autoConnect ?? true,
    startupTimeoutMs: cfg.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    requestTimeoutMs: cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    requestTimeoutMsByTool: cfg.requestTimeoutMsByTool ?? {},
    disabledTools: new Set(cfg.disabledTools ?? []),
    authSource: auth.source,
  };
}

export function hasAuth(cfg: ResolvedConfig): boolean {
  return Boolean(cfg.headers.Authorization || cfg.headers.authorization);
}
