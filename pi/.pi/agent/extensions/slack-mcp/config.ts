// =============================================================================
// Config loading (the per-machine ~/.pi/agent/slack-mcp.json auth file)
// =============================================================================

import { existsSync, readFileSync } from "node:fs";
import {
  AUTH_FILE,
  DEFAULT_ARGS,
  DEFAULT_COMMAND,
  DEFAULT_DROP_COLUMNS,
  DEFAULT_MAX_TEXT_LENGTH,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_TOOL_PREFIX,
} from "./constants";
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
    env: cfg?.env ?? {},
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

export function hasAuthEnv(env: Record<string, string>): boolean {
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
