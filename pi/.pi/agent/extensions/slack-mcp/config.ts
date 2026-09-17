// =============================================================================
// Config loading (the per-machine ~/.pi/agent/slack-mcp.json auth file)
// =============================================================================

import { existsSync, readFileSync } from "node:fs";
import {
  AUTH_FILE,
  DEFAULT_ARGS,
  DEFAULT_COMMAND,
  DEFAULT_DROP_COLUMNS,
  DEFAULT_MAX_RESPONSE_CHARS,
  DEFAULT_MAX_ROWS,
  DEFAULT_MAX_TEXT_LENGTH,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_TOOL_PREFIX,
} from "./constants";
import { resolveEffectiveSlackEnv, resolveSlackCredentials } from "./credentials";
import type { PostProcessConfig, ResolvedConfig, ResolvedPostProcess, SlackMCPConfig } from "./types";

export function loadConfig(): SlackMCPConfig | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as SlackMCPConfig;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[slack-mcp] Failed to parse ${AUTH_FILE}: ${msg}`);
    return null;
  }
}

export function resolveConfig(cfg: SlackMCPConfig | null): ResolvedConfig {
  return {
    command: cfg?.command || DEFAULT_COMMAND,
    args: cfg?.args ?? DEFAULT_ARGS,
    env: resolveEffectiveSlackEnv(cfg?.env),
    toolPrefix: cfg?.toolPrefix ?? DEFAULT_TOOL_PREFIX,
    startupTimeoutMs: cfg?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    requestTimeoutMs: cfg?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    requestTimeoutMsByTool: cfg?.requestTimeoutMsByTool ?? {},
    postProcess: resolvePostProcess(cfg?.postProcess),
    disabledTools: new Set(cfg?.disabledTools ?? []),
  };
}

export function resolvePostProcess(pp?: PostProcessConfig | boolean): ResolvedPostProcess {
  if (pp === false) {
    return {
      enabled: false,
      dropColumns: new Set(),
      maxTextLength: 0,
      maxResponseChars: 0,
      maxRows: 0,
      resolveMentions: false,
    };
  }
  const o = pp && typeof pp === "object" ? pp : {};
  return {
    enabled: o.enabled ?? true,
    dropColumns: new Set(o.dropColumns ?? DEFAULT_DROP_COLUMNS),
    maxTextLength: o.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    maxResponseChars: o.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS,
    maxRows: o.maxRows ?? DEFAULT_MAX_ROWS,
    resolveMentions: o.resolveMentions ?? true,
  };
}

export function hasAuthEnv(env: Record<string, string>): boolean {
  return resolveSlackCredentials(env) !== null;
}
