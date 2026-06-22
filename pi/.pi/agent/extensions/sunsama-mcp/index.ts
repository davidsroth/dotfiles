/**
 * Sunsama MCP Client Extension for pi.
 *
 * Bridges the hosted Sunsama "tasks" MCP server into pi. By default it reuses
 * Claude Code's existing global `tasks` MCP Authorization header from
 * `~/.claude.json`; no token is stored in this repo. You can override auth with:
 *   - SUNSAMA_MCP_AUTHORIZATION='Bearer ...'
 *   - SUNSAMA_MCP_BEARER_TOKEN='...'
 *   - ~/.pi/agent/sunsama-mcp.json: { "authorization": "Bearer ..." }
 *
 * Commands:
 *   /tasks                 connect / show status / disconnect / restart
 *
 * LLM-callable control tools:
 *   tasks_mcp_connect, tasks_mcp_disconnect, tasks_mcp_status, tasks_mcp_call
 *
 * Dynamic tools:
 *   Every upstream Sunsama MCP tool, prefixed by `toolPrefix` (default `tasks_`),
 *   for example tasks_create_task, tasks_get_backlog_tasks, tasks_search_tasks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONFIG_FILE } from "./constants";
import { hasAuth, loadConfig, resolveConfig } from "./config";
import { HttpMCPClient } from "./http-client";
import { enabledTools, statusText, toolError, toolResult, type StatusDiagnostics } from "./tool-helpers";
import type { NotifyFn, NotifyLevel, ResolvedConfig } from "./types";

export default async function sunsamaMCPExtension(pi: ExtensionAPI): Promise<void> {
  let cfg: ResolvedConfig = resolveConfig(loadConfig());
  let client: HttpMCPClient | null = null;
  const registeredToolNames = new Set<string>();

  const refreshConfig = (): ResolvedConfig => {
    cfg = resolveConfig(loadConfig());
    return cfg;
  };

  const notify = (message: string, type: NotifyLevel = "info") => {
    try {
      pi.events.emit("ui:notify", { message, type });
    } catch {
      console.log(`[sunsama-mcp] ${message}`);
    }
  };

  const registryDiagnostics = (): StatusDiagnostics => {
    const controlToolNames = new Set(["tasks_mcp_connect", "tasks_mcp_disconnect", "tasks_mcp_status", "tasks_mcp_call"]);
    const isTasksTool = (name: string) => name.startsWith(cfg.toolPrefix) && !controlToolNames.has(name);
    try {
      return {
        registeredToolNames: pi.getAllTools().map((t) => t.name).filter(isTasksTool).sort(),
        activeToolNames: pi.getActiveTools().filter(isTasksTool).sort(),
      };
    } catch {
      return {};
    }
  };

  const registerDynamicTools = (): number => {
    if (!client) return 0;
    let enabledCount = 0;
    let known: Set<string>;
    try {
      known = new Set(pi.getAllTools().map((t) => t.name));
    } catch {
      known = new Set();
    }

    for (const tool of client.getTools()) {
      if (cfg.disabledTools.has(tool.name)) continue;
      enabledCount++;
      const piName = `${cfg.toolPrefix}${tool.name}`;
      if (known.has(piName) || registeredToolNames.has(piName)) continue;
      pi.registerTool({
        name: piName,
        label: `Sunsama: ${tool.name.replace(/_/g, " ")}`,
        description: tool.description ? `[Sunsama MCP] ${tool.description}` : `[Sunsama MCP] Tool: ${tool.name}`,
        parameters: Type.Unsafe(tool.inputSchema),
        async execute(_toolCallId, params, signal) {
          if (!client?.isConnected) return toolError(piName, "Not connected to Sunsama MCP. Run /tasks to connect.");
          try {
            const result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, signal);
            const details = { upstreamTool: tool.name, raw: result.raw };
            return result.isError ? toolError(piName, result.text || `Sunsama tool ${tool.name} returned an error.`, details) : toolResult(piName, result.text || "", details);
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

  const doConnect = async (n: NotifyFn): Promise<{ ok: true; tools: number } | { ok: false; error: string }> => {
    const config = refreshConfig();
    if (!hasAuth(config)) {
      return { ok: false, error: `No Sunsama MCP auth found. Set SUNSAMA_MCP_AUTHORIZATION/SUNSAMA_MCP_BEARER_TOKEN, create ${CONFIG_FILE}, or authenticate Claude Code's global 'tasks' MCP.` };
    }
    if (client?.isConnected) return { ok: true, tools: registerDynamicTools() };

    n(`Connecting to Sunsama MCP (${config.url})...`);
    const next = new HttpMCPClient();
    try {
      await next.connect(config);
      client = next;
      return { ok: true, tools: registerDynamicTools() };
    } catch (error) {
      next.disconnect();
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: msg };
    }
  };

  pi.registerCommand("tasks", {
    description: "Connect/disconnect/restart the Sunsama tasks MCP server, or show status",
    handler: async (_args, ctx) => {
      const uiNotify: NotifyFn = (message, type = "info") => ctx.ui.notify(message, type);
      if (!client?.isConnected) {
        const result = await doConnect(uiNotify);
        ctx.ui.notify(result.ok ? `Connected to Sunsama MCP. ${result.tools} tools registered.` : `Sunsama MCP connect failed: ${result.error}`, result.ok ? "info" : "error");
        return;
      }

      const choice = await ctx.ui.select(statusText(client, cfg, registryDiagnostics()), ["Restart", "Disconnect", "Cancel"]);
      if (choice === "Disconnect") {
        client.disconnect();
        client = null;
        ctx.ui.notify("Disconnected from Sunsama MCP.", "info");
      } else if (choice === "Restart") {
        client.disconnect();
        client = null;
        const result = await doConnect(uiNotify);
        ctx.ui.notify(result.ok ? `Reconnected. ${result.tools} tools.` : `Reconnect failed: ${result.error}`, result.ok ? "info" : "error");
      }
    },
  });

  pi.registerTool({
    name: "tasks_mcp_connect",
    label: "Sunsama MCP Connect",
    description: "Connect to the hosted Sunsama tasks MCP server and register its tools in pi",
    parameters: Type.Object({}),
    async execute() {
      if (client?.isConnected) return toolResult("tasks_mcp_connect", `Already connected. ${enabledTools(client, cfg).length} tools registered with prefix '${cfg.toolPrefix}'.`);
      const result = await doConnect(notify);
      return result.ok
        ? toolResult("tasks_mcp_connect", `Connected to Sunsama MCP. ${result.tools} tools registered with prefix '${cfg.toolPrefix}'.`)
        : toolError("tasks_mcp_connect", result.error);
    },
  });

  pi.registerTool({
    name: "tasks_mcp_disconnect",
    label: "Sunsama MCP Disconnect",
    description: "Disconnect this pi session from the Sunsama tasks MCP server",
    parameters: Type.Object({}),
    async execute() {
      if (!client) return toolResult("tasks_mcp_disconnect", "Not connected.");
      client.disconnect();
      client = null;
      return toolResult("tasks_mcp_disconnect", "Disconnected from Sunsama MCP.");
    },
  });

  pi.registerTool({
    name: "tasks_mcp_call",
    label: "Sunsama MCP Call",
    description: "Call an upstream Sunsama MCP tool by name. Useful when dynamic tasks_* tools were just registered but are not exposed in the current tool schema yet.",
    parameters: Type.Object({
      tool: Type.String({ description: "Upstream Sunsama MCP tool name, with or without the configured prefix (for example: create_task or tasks_create_task). You may append inline JSON args after the name, e.g. 'search_tasks {\"searchTerm\":\"demo\"}'." }),
      args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "JSON arguments to pass to the upstream Sunsama MCP tool." })),
    }),
    async execute(_toolCallId, params, signal) {
      const p = params as { tool?: unknown; args?: unknown; arguments?: unknown };
      let rawTool = String(p.tool ?? "").trim();
      if (!rawTool) return toolError("tasks_mcp_call", "Missing required 'tool' parameter.");
      let rawArgs = p.args ?? p.arguments ?? {};
      const inlineJson = rawTool.match(/^(\S+)\s+({[\s\S]*})$/);
      if (inlineJson && (rawArgs === undefined || (typeof rawArgs === "object" && rawArgs !== null && Object.keys(rawArgs as Record<string, unknown>).length === 0))) {
        rawTool = inlineJson[1];
        try { rawArgs = JSON.parse(inlineJson[2]) as Record<string, unknown>; }
        catch (error) { return toolError("tasks_mcp_call", `Invalid inline JSON args after tool name: ${(error as Error).message}`); }
      }
      if (typeof rawArgs === "string") {
        try { rawArgs = rawArgs.trim() ? JSON.parse(rawArgs) : {}; }
        catch (error) { return toolError("tasks_mcp_call", `Invalid JSON in args string: ${(error as Error).message}`); }
      }
      if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) return toolError("tasks_mcp_call", "args must be a JSON object.");

      const connected = client?.isConnected ? { ok: true as const, tools: 0 } : await doConnect(notify);
      if (!connected.ok) return toolError("tasks_mcp_call", connected.error);
      if (!client?.isConnected) return toolError("tasks_mcp_call", "Not connected to Sunsama MCP.");

      const upstreamTool = rawTool.startsWith(cfg.toolPrefix) ? rawTool.slice(cfg.toolPrefix.length) : rawTool;
      if (cfg.disabledTools.has(upstreamTool)) return toolError("tasks_mcp_call", `Sunsama tool '${cfg.toolPrefix}${upstreamTool}' is disabled by ${CONFIG_FILE}.`, { upstreamTool });
      if (!client.getTools().some((tool) => tool.name === upstreamTool)) {
        const available = enabledTools(client, cfg).map((tool) => `${cfg.toolPrefix}${tool.name}`);
        return toolError("tasks_mcp_call", `Unknown Sunsama MCP tool '${rawTool}'. Enabled tools: ${available.join(", ") || "(none)"}`, { upstreamTool, available });
      }

      try {
        const args = rawArgs as Record<string, unknown>;
        const result = await client.callTool(upstreamTool, args, signal);
        const details = { upstreamTool, calledAs: rawTool, args, raw: result.raw };
        return result.isError ? toolError("tasks_mcp_call", result.text || `Sunsama tool ${upstreamTool} returned an error.`, details) : toolResult("tasks_mcp_call", result.text || "", details);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return toolError("tasks_mcp_call", `Error calling ${upstreamTool}: ${msg}`, { upstreamTool, error: msg });
      }
    },
  });

  pi.registerTool({
    name: "tasks_mcp_status",
    label: "Sunsama MCP Status",
    description: "Check Sunsama tasks MCP connection status and list available tools",
    parameters: Type.Object({}),
    async execute() {
      const diagnostics = registryDiagnostics();
      return toolResult("tasks_mcp_status", statusText(client, cfg, diagnostics), {
        connected: client?.isConnected ?? false,
        upstreamToolCount: client?.getTools().length ?? 0,
        enabledToolCount: enabledTools(client, cfg).length,
        registeredToolCount: diagnostics.registeredToolNames?.length,
        activeToolCount: diagnostics.activeToolNames?.length,
        authSource: cfg.authSource,
      });
    },
  });

  pi.on("session_shutdown", async () => {
    client?.disconnect();
    client = null;
  });

  if (cfg.autoConnect && hasAuth(cfg) && process.env.PI_OFFLINE !== "1") {
    const result = await doConnect(notify);
    if (!result.ok) console.warn(`[sunsama-mcp] autoConnect failed: ${result.error}`);
  }
}
