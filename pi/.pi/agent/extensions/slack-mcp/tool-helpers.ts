// =============================================================================
// Pi tool wiring helpers (result shaping + status text)
// =============================================================================

import { existsSync } from "node:fs";
import { AUTH_FILE } from "./constants";
import { hasAuthEnv } from "./config";
import type { StdioMCPClient } from "./mcp-client";
import { sharedRefCount } from "./registry";
import type { MCPTool, ResolvedConfig, ToolExecutionResult } from "./types";

export const COMPOSITE_SLACK_TOOL_NAMES = [
  "slack_my_conversations",
  "slack_search_messages_batch",
  "slack_open_message",
  "slack_threads_get_many",
] as const;

export const CONTROL_SLACK_TOOL_NAMES = [
  "slack_mcp_connect",
  "slack_mcp_disconnect",
  "slack_mcp_call",
  "slack_mcp_status",
  "slack_mcp_whoami",
] as const;

export const STATIC_SLACK_TOOL_NAMES = [
  ...CONTROL_SLACK_TOOL_NAMES,
  ...COMPOSITE_SLACK_TOOL_NAMES,
] as const;

export function toolResult(tool: string, text: string, details: Record<string, unknown> = {}): ToolExecutionResult {
  return {
    content: [{ type: "text", text }],
    details: { tool, ...details },
  };
}

export function toolError(tool: string, text: string, details: Record<string, unknown> = {}): ToolExecutionResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { tool, ...details },
  };
}

export interface StatusDiagnostics {
  /** Always-defined wrapper tools registered in this pi session. */
  staticRegisteredToolNames?: string[];
  /** Always-defined wrapper tools currently active in the model tool set. */
  staticActiveToolNames?: string[];
  /** Dynamically discovered upstream tools registered after connecting. */
  dynamicRegisteredToolNames?: string[];
  /** Dynamically discovered upstream tools currently active in the model tool set. */
  dynamicActiveToolNames?: string[];
}

export function enabledSlackTools(client: StdioMCPClient | null, cfg: ResolvedConfig): MCPTool[] {
  return (client?.getTools() ?? []).filter((tool) => !cfg.disabledTools.has(tool.name));
}

export function statusText(
  client: StdioMCPClient | null,
  cfg: ResolvedConfig,
  diagnostics: StatusDiagnostics = {},
): string {
  const upstreamTools = client?.getTools() ?? [];
  const enabledTools = enabledSlackTools(client, cfg);
  const disabledTools = upstreamTools.filter((tool) => cfg.disabledTools.has(tool.name));
  const auth = hasAuthEnv(cfg.env) ? "configured" : "MISSING (set SLACK_MCP_XOXP_TOKEN, XOXB, or XOXC+XOXD)";
  const refs = client ? sharedRefCount(client) : 0;
  const connected = client?.isConnected ?? false;
  const sharedNote =
    refs > 1
      ? ` (shared with ${refs - 1} other session${refs - 1 === 1 ? "" : "s"})`
      : "";
  const staticRegistered = diagnostics.staticRegisteredToolNames;
  const staticActive = diagnostics.staticActiveToolNames;
  const dynamicRegistered = diagnostics.dynamicRegisteredToolNames;
  const dynamicActive = diagnostics.dynamicActiveToolNames;
  const lines: string[] = [
    `Slack MCP Status:`,
    `- Upstream connection: ${connected ? `Connected${sharedNote}` : "Not connected"}`,
    `- Lazy connect: composite read tools and slack_mcp_call connect on first use; dynamic ${cfg.toolPrefix}* tools are discovered and registered only after a connection.`,
    `- Auth file: ${existsSync(AUTH_FILE) ? AUTH_FILE : `${AUTH_FILE} (missing)`}`,
    `- Command: ${cfg.command} ${cfg.args.join(" ")}`,
    `- Auth: ${auth}`,
    `- Tool prefix: '${cfg.toolPrefix}'`,
    `- Static wrapper tools defined: ${STATIC_SLACK_TOOL_NAMES.length} (${COMPOSITE_SLACK_TOOL_NAMES.length} composite read, ${CONTROL_SLACK_TOOL_NAMES.length} control/direct)`,
    `- Dynamic upstream tools discovered: ${upstreamTools.length}${connected ? "" : " (requires a connection)"}`,
    `- Dynamic upstream tools enabled by config: ${enabledTools.length}`,
  ];
  if (staticRegistered) lines.push(`- Static wrapper tools registered in this session: ${staticRegistered.length}`);
  if (staticActive) lines.push(`- Static wrapper tools active in this session: ${staticActive.length}`);
  if (dynamicRegistered) lines.push(`- Dynamic upstream tools registered in this session: ${dynamicRegistered.length}`);
  if (dynamicActive) lines.push(`- Dynamic upstream tools active in this session: ${dynamicActive.length}`);

  lines.push("");
  lines.push("Static wrapper tools:");
  for (const name of STATIC_SLACK_TOOL_NAMES) lines.push(`  - ${name}`);

  if (enabledTools.length > 0) {
    lines.push("");
    lines.push("Enabled dynamic upstream tools:");
    for (const t of enabledTools) lines.push(`  - ${cfg.toolPrefix}${t.name}`);
  }
  if (disabledTools.length > 0) {
    lines.push("");
    lines.push("Disabled by config (discovered upstream but not registered as pi tools):");
    for (const t of disabledTools) lines.push(`  - ${cfg.toolPrefix}${t.name}`);
  }
  if (dynamicRegistered && dynamicRegistered.length > 0) {
    lines.push("");
    lines.push("Registered dynamic upstream tools:");
    for (const name of dynamicRegistered) lines.push(`  - ${name}`);
  }
  if (!connected) lines.push("\nUse slack_mcp_connect or /slack to connect explicitly, or call an upstream-dependent static wrapper to connect lazily.");
  return lines.join("\n");
}
