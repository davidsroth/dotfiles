// =============================================================================
// Pi tool wiring helpers
// =============================================================================

import { existsSync } from "node:fs";
import { CONFIG_FILE } from "./constants";
import { hasAuth } from "./config";
import type { HttpMCPClient } from "./http-client";
import type { MCPTool, ResolvedConfig, ToolExecutionResult } from "./types";

export function toolResult(tool: string, text: string, details: Record<string, unknown> = {}): ToolExecutionResult {
  return { content: [{ type: "text", text }], details: { tool, ...details } };
}

export function toolError(tool: string, text: string, details: Record<string, unknown> = {}): ToolExecutionResult {
  return { content: [{ type: "text", text }], isError: true, details: { tool, ...details } };
}

export interface StatusDiagnostics {
  registeredToolNames?: string[];
  activeToolNames?: string[];
}

export function enabledTools(client: HttpMCPClient | null, cfg: ResolvedConfig): MCPTool[] {
  return (client?.getTools() ?? []).filter((tool) => !cfg.disabledTools.has(tool.name));
}

export function statusText(client: HttpMCPClient | null, cfg: ResolvedConfig, diagnostics: StatusDiagnostics = {}): string {
  const upstreamTools = client?.getTools() ?? [];
  const active = enabledTools(client, cfg);
  const disabled = upstreamTools.filter((tool) => cfg.disabledTools.has(tool.name));
  const lines: string[] = [
    "Sunsama MCP Status:",
    `- Connected: ${client?.isConnected ? "Yes" : "No"}`,
    `- Endpoint: ${cfg.url}`,
    `- Config file: ${existsSync(CONFIG_FILE) ? CONFIG_FILE : `${CONFIG_FILE} (missing)`}`,
    `- Auth: ${hasAuth(cfg) ? `configured via ${cfg.authSource}` : "MISSING"}`,
    `- Auto-connect: ${cfg.autoConnect}`,
    `- Tool prefix: '${cfg.toolPrefix}'`,
    `- Upstream tools discovered: ${upstreamTools.length}`,
    `- Pi tools enabled by config: ${active.length}`,
  ];
  if (diagnostics.registeredToolNames) lines.push(`- Pi tools registered in this session: ${diagnostics.registeredToolNames.length}`);
  if (diagnostics.activeToolNames) lines.push(`- Pi tools active in this session: ${diagnostics.activeToolNames.length}`);

  if (active.length > 0) {
    lines.push("", "Enabled Sunsama tools:");
    for (const t of active) lines.push(`  - ${cfg.toolPrefix}${t.name}`);
  }
  if (disabled.length > 0) {
    lines.push("", "Disabled by config (discovered upstream but not registered as pi tools):");
    for (const t of disabled) lines.push(`  - ${cfg.toolPrefix}${t.name}`);
  }
  if (!client?.isConnected) lines.push("", "Run /tasks or call tasks_mcp_connect to connect.");
  if (!hasAuth(cfg)) {
    lines.push(
      "",
      "Auth options:",
      "  - set SUNSAMA_MCP_AUTHORIZATION='Bearer ...' or SUNSAMA_MCP_BEARER_TOKEN",
      `  - or create ${CONFIG_FILE} with { \"authorization\": \"Bearer ...\" }`,
      "  - or keep Claude Code's global 'tasks' MCP auth in ~/.claude.json (used as a fallback)",
    );
  }
  return lines.join("\n");
}
