// =============================================================================
// Pi tool wiring helpers (result shaping + status text)
// =============================================================================

import { existsSync } from "node:fs";
import { AUTH_FILE } from "./constants";
import { hasAuthEnv } from "./config";
import type { StdioMCPClient } from "./mcp-client";
import { sharedRefCount } from "./registry";
import type { MCPTool, ResolvedConfig, ToolExecutionResult } from "./types";

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
  /** pi registry entries matching this Slack prefix (post registerTool). */
  registeredToolNames?: string[];
  /** Currently active pi tools matching this Slack prefix (sent to the model on provider requests). */
  activeToolNames?: string[];
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
