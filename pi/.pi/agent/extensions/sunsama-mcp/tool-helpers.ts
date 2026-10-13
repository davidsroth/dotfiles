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

export function isDirectTool(cfg: ResolvedConfig, name: string): boolean {
  return cfg.directTools === "all" || cfg.directTools.has(name);
}

/**
 * Drop per-provider `integration` link schemas (a `oneOf` over 14 services, ~8k tokens on
 * create_task alone) from a directly declared tool. `integrationUrl` remains and Sunsama
 * resolves links from it; the full schema stays available via tasks_mcp_call describe.
 */
export function slimSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(slimSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(value as Record<string, unknown>)) {
        if (name === "integration" && prop && typeof prop === "object" && "oneOf" in (prop as object)) continue;
        props[name] = slimSchema(prop);
      }
      out[key] = props;
    } else out[key] = slimSchema(value);
  }
  if (Array.isArray(out.required)) out.required = (out.required as string[]).filter((name) => !out.properties || name in (out.properties as object));
  return out;
}

/** One line per tool, for tasks_mcp_call's description. */
export function toolCatalog(tools: MCPTool[], prefix: string): string {
  return tools.map((tool) => {
    const first = (tool.description ?? "").split(/(?<=\.)\s/)[0].replace(/\s+/g, " ").trim();
    return `${prefix}${tool.name}: ${first.length > 110 ? `${first.slice(0, 107)}...` : first}`;
  }).join("\n");
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
