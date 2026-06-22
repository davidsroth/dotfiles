/**
 * Slack MCP Client Extension for pi
 *
 * Bridges the korotovsky/slack-mcp-server (or any compatible stdio MCP server)
 * into pi by spawning it as a child process, performing the MCP handshake,
 * and registering each remote tool as a pi tool.
 *
 * Auth file (NOT stowed; per-machine secrets):
 *   ~/.pi/agent/slack-mcp.json
 *
 *   {
 *     "command": "npx",                                  // optional; defaults shown
 *     "args": ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
 *     "env": {
 *       "SLACK_MCP_XOXP_TOKEN": "xoxp-..."               // OR XOXB, OR XOXC+XOXD
 *     },
 *     "autoConnect": true,                               // connect at extension load
 *     "toolPrefix": "slack_",                            // prefix for registered tool names
 *     "requestTimeoutMs": 60000,                         // optional: per-tool-call timeout (default 60000)
 *     "requestTimeoutMsByTool": {                        // optional: per-upstream-tool overrides
 *       "conversations_unreads": 180000                  //   (slow over many channels)
 *     },
 *     "postProcess": {                                   // optional: trim/clean CSV output (default on)
 *       "dropColumns": ["Permalink", "AttachmentIDs", "HasMedia", "BotName", "Cursor"],
 *       "maxTextLength": 2000,                           //   0 disables truncation
 *       "resolveMentions": true                          //   <@U…> -> @name
 *     },                                                 //   set "postProcess": false to disable entirely
 *     "disabledTools": ["usergroups_create", "users_search"]  // optional: skip these upstream tools
 *   }
 *
 * postProcess (CSV output cleanup): drops wide rarely-used columns, truncates
 * long Text blobs, and resolves <@U…>/<#C…> mentions to @name/#name. Dropping
 * `Cursor` preserves pagination via a `next_cursor: <value>` footer. Output that
 * doesn't parse as consistent CSV is passed through untouched. To recover a
 * dropped field (e.g. Permalink) set a custom `dropColumns` list omitting it,
 * or set `"postProcess": false` for fully raw upstream output.
 *
 * Per-call overrides (no config edit needed): message-text tools
 * (conversations_history/replies/search_messages) accept `_maxTextLength`
 * (override truncation for one call; 0 = none) and `_raw` (true = fully raw
 * output for one call). These args are stripped before forwarding upstream.
 *
 * `disabledTools` matches against upstream tool names (without `toolPrefix`).
 * Use this to trim system-prompt token weight by hiding tools you never call.
 * Example: omit all usergroup management to drop ~30% of Slack's tool tokens:
 *   "disabledTools": ["usergroups_create", "usergroups_list", "usergroups_me",
 *                     "usergroups_update", "usergroups_users_update"]
 *
 * Commands:
 *   /slack                connect / show status / disconnect / restart
 *
 * LLM-callable tools (always present):
 *   slack_mcp_connect, slack_mcp_disconnect, slack_mcp_status, slack_mcp_call,
 *   slack_mcp_whoami (auth.test — returns the authenticated user_id; use
 *   `from:<user_id>` in searches since `from:@me` is unsupported by Slack)
 *
 * Plus every tool reported by the upstream MCP server (e.g. conversations_history,
 * channels_list, conversations_search_messages), each prefixed with `toolPrefix`.
 *
 * ---------------------------------------------------------------------------
 * Module layout (this is the orchestration entry point):
 *   constants.ts       — defaults + child-env allowlist
 *   types.ts           — shared data shapes
 *   config.ts          — auth-file loading / resolution
 *   identity.ts        — Slack auth.test / users.info (whoami)
 *   postprocess.ts     — CSV trimming + mention resolution
 *   process-tracker.ts — child-PID tracking + last-resort reaper
 *   mcp-client.ts      — StdioMCPClient (spawn + JSON-RPC handshake)
 *   registry.ts        — cross-session shared-client refcounting
 *   tool-helpers.ts    — tool-result shaping + status text
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AUTH_FILE, TOOL_DESCRIPTION_NOTES } from "./constants";
import { hasAuthEnv, loadConfig, resolveConfig } from "./config";
import { slackAuthTest } from "./identity";
import type { StdioMCPClient } from "./mcp-client";
import { augmentSchemaWithControls } from "./postprocess";
import { acquireClient, acquireExistingRef, peekConnectedShared, releaseClient, sharedRefCount } from "./registry";
import {
  enabledSlackTools,
  type StatusDiagnostics,
  statusText,
  toolError,
  toolResult,
} from "./tool-helpers";
import type { NotifyFn, NotifyLevel, ResolvedConfig } from "./types";

export default async function slackMCPExtension(pi: ExtensionAPI): Promise<void> {
  let cfg: ResolvedConfig = resolveConfig(loadConfig());
  const registeredToolNames = new Set<string>();

  // Reference to the shared StdioMCPClient this session holds a ref on, or
  // null if not currently connected. May point to a client other sessions
  // are also using (e.g. parent + N subagents share one). Set by the sync
  // fast-path below, by doConnect, or by the slack_mcp_connect tool.
  let client: StdioMCPClient | null = null;

  const refreshConfig = (): ResolvedConfig => {
    cfg = resolveConfig(loadConfig());
    return cfg;
  };

  const notify = (message: string, type: NotifyLevel = "info") => {
    try {
      pi.events.emit("ui:notify", { message, type });
    } catch {
      console.log(`[slack-mcp] ${message}`);
    }
  };

  const registryDiagnostics = (): StatusDiagnostics => {
    try {
      const controlToolNames = new Set(["slack_mcp_connect", "slack_mcp_disconnect", "slack_mcp_call", "slack_mcp_status", "slack_mcp_whoami"]);
      const isSlackTool = (name: string) => name.startsWith(cfg.toolPrefix) && !controlToolNames.has(name);
      return {
        registeredToolNames: pi.getAllTools().map((t) => t.name).filter(isSlackTool).sort(),
        activeToolNames: pi.getActiveTools().filter(isSlackTool).sort(),
      };
    } catch {
      return {};
    }
  };

  const registerDynamicTools = (): number => {
    if (!client) return 0;
    let enabledCount = 0;
    const prefix = cfg.toolPrefix;
    // `pi.getAllTools()` is a throwing stub during extension factory execution
    // (see pi-coding-agent loader.js createExtensionRuntime: action methods are
    // wired only after the runner binds). The sync fast-path below calls
    // registerDynamicTools() at factory time, so we must not call it then.
    // After bindExtensions resolves, getAllTools() works normally.
    //
    // We fall back to our own `registeredToolNames` set, which is sufficient
    // for within-this-extension dedup. Cross-extension name collisions on
    // `${prefix}<upstream-tool>` are vanishingly unlikely given the slack_
    // prefix and would just shadow rather than throw.
    let known: Set<string>;
    try {
      known = new Set(pi.getAllTools().map((t) => t.name));
    } catch {
      known = new Set();
    }

    for (const tool of client.getTools()) {
      if (cfg.disabledTools.has(tool.name)) continue;
      enabledCount++;
      const piName = `${prefix}${tool.name}`;
      if (known.has(piName) || registeredToolNames.has(piName)) continue;

      const baseDescription = tool.description
        ? `[Slack MCP] ${tool.description}`
        : `[Slack MCP] Slack tool: ${tool.name}`;
      const note = TOOL_DESCRIPTION_NOTES[tool.name];
      const description = note ? `${baseDescription}\n\n${note}` : baseDescription;

      pi.registerTool({
        name: piName,
        label: `Slack: ${tool.name.replace(/_/g, " ")}`,
        description,
        // Pass the upstream JSON Schema through, augmented (for message-text
        // tools) with the wrapper's per-call override args.
        parameters: Type.Unsafe(augmentSchemaWithControls(tool.inputSchema, tool.name, cfg.postProcess)),
        async execute(_toolCallId, params) {
          // Re-check `client` each call: a /slack force-restart from another
          // session can drop our reference. The closure captures the outer
          // `let client`, so this reads the current value, not entry-time.
          if (!client || !client.isConnected) {
            return toolError(piName, "Not connected to Slack MCP. Run /slack to connect.");
          }
          try {
            const text = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>);
            return toolResult(piName, text || "", { upstreamTool: tool.name });
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

  const doConnect = async (
    n: NotifyFn,
  ): Promise<{ ok: true; tools: number; shared: boolean } | { ok: false; error: string }> => {
    const config = refreshConfig();
    if (!hasAuthEnv(config.env)) {
      return {
        ok: false,
        error: `No Slack auth tokens found. Create ${AUTH_FILE} with an "env" block containing SLACK_MCP_XOXP_TOKEN (or XOXB, or XOXC+XOXD).`,
      };
    }
    // If we already hold a ref (e.g. sync fast-path took one at entry), just
    // re-register dynamic tools in case the upstream tool list changed.
    if (client?.isConnected) {
      const registeredTools = registerDynamicTools();
      return { ok: true, tools: registeredTools, shared: sharedRefCount(client) > 1 };
    }
    const alreadyConnected = peekConnectedShared(config) !== null;
    if (!alreadyConnected) {
      n(`Spawning Slack MCP server (${config.command} ${config.args.join(" ")})...`);
    }
    try {
      client = await acquireClient(config);
      const registeredTools = registerDynamicTools();
      return { ok: true, tools: registeredTools, shared: sharedRefCount(client) > 1 };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: msg };
    }
  };

  // === Synchronous fast-path ===============================================
  // If a shared client is already connected for this config (e.g. the parent
  // session connected before spawning us), take a ref and register dynamic
  // tools NOW — synchronously, before this extension entry function returns.
  // That puts the dynamic slack_* tools in the registry before bindExtensions
  // resolves, so pi-subagents' getAllTools() snapshot picks them up on turn 1.
  //
  // We bypass `acquireClient` (which is async) because we need this to land
  // synchronously. Safe because we only call this when peek confirms the
  // entry exists AND is connected — no handshake to await.
  //
  // Gated on `autoConnect`: if the user explicitly set `autoConnect: false`,
  // they don't want Slack tools registered automatically in this session,
  // even if a sibling session has a shared connection alive. They can still
  // attach on demand via `/slack connect` or `slack_mcp_connect`.
  if (loadConfig()?.autoConnect !== false) {
    const existing = peekConnectedShared(cfg);
    if (existing && acquireExistingRef(cfg, existing)) {
      client = existing;
      registerDynamicTools();
    }
  }

  // /slack command -----------------------------------------------------------
  pi.registerCommand("slack", {
    description: "Connect/disconnect/restart the Slack MCP server, or show status",
    handler: async (_args, ctx) => {
      const uiNotify: NotifyFn = (message, type = "info") => ctx.ui.notify(message, type);

      if (!client?.isConnected) {
        const result = await doConnect(uiNotify);
        if (result.ok) {
          const sharedNote = result.shared ? " (joined shared session)" : "";
          ctx.ui.notify(`Connected to Slack MCP. ${result.tools} tools registered${sharedNote}.`, "info");
        } else {
          ctx.ui.notify(`Slack MCP connect failed: ${result.error}`, "error");
        }
        return;
      }

      const refs = sharedRefCount(client);
      const choice = await ctx.ui.select(statusText(client, cfg, registryDiagnostics()), ["Restart", "Disconnect", "Cancel"]);
      if (choice === "Disconnect") {
        const heldClient = client;
        client = null;
        await releaseClient(heldClient);
        ctx.ui.notify(
          refs > 1
            ? `Released this session's slot. ${refs - 1} other session(s) still using the shared connection.`
            : "Disconnected from Slack MCP.",
          "info",
        );
      } else if (choice === "Restart") {
        if (refs > 1) {
          ctx.ui.notify(
            `Force-restart will affect ${refs - 1} other session(s) — their slack_* calls will fail until they reconnect.`,
            "info",
          );
        }
        const heldClient = client;
        client = null;
        await releaseClient(heldClient, { force: true });
        const result = await doConnect(uiNotify);
        if (result.ok) ctx.ui.notify(`Reconnected. ${result.tools} tools.`, "info");
        else ctx.ui.notify(`Reconnect failed: ${result.error}`, "error");
      }
    },
  });

  // Always-on control tools -------------------------------------------------
  pi.registerTool({
    name: "slack_mcp_connect",
    label: "Slack MCP Connect",
    description: "Spawn the Slack MCP server, perform handshake, and register Slack tools",
    parameters: Type.Object({}),
    async execute() {
      if (client?.isConnected) {
        return toolResult(
          "slack_mcp_connect",
          `Already connected. ${enabledSlackTools(client, cfg).length} Slack tools registered with prefix '${cfg.toolPrefix}'.`,
        );
      }
      const result = await doConnect(notify);
      if (result.ok) {
        const sharedNote = result.shared ? " (joined shared session)" : "";
        return toolResult(
          "slack_mcp_connect",
          `Connected to Slack MCP. ${result.tools} tools registered with prefix '${cfg.toolPrefix}'${sharedNote}.`,
        );
      }
      return toolError("slack_mcp_connect", result.error);
    },
  });

  pi.registerTool({
    name: "slack_mcp_disconnect",
    label: "Slack MCP Disconnect",
    description: "Release this session's reference to the Slack MCP server (kills the child process if no other sessions are using it)",
    parameters: Type.Object({}),
    async execute() {
      if (!client) return toolResult("slack_mcp_disconnect", "Not connected.");
      const refs = sharedRefCount(client);
      const heldClient = client;
      client = null;
      await releaseClient(heldClient);
      const text =
        refs > 1
          ? `Released this session's slot. ${refs - 1} other session(s) still using the shared connection.`
          : "Disconnected from Slack MCP.";
      return toolResult("slack_mcp_disconnect", text, { wasShared: refs > 1, remainingRefs: Math.max(0, refs - 1) });
    },
  });

  pi.registerTool({
    name: "slack_mcp_call",
    label: "Slack MCP Call",
    description: "Call an upstream Slack MCP tool by name. Useful when dynamic slack_* tools were just registered but are not exposed in the current tool schema yet.",
    parameters: Type.Object({
      tool: Type.String({
        description: "Upstream Slack MCP tool name, with or without the configured prefix (for example: conversations_search_messages or slack_conversations_search_messages). If the tool schema in this session only exposes this field, you may append a JSON object after the name, e.g. 'slack_conversations_search_messages {\"search_query\":\"from:@me\"}'.",
      }),
      args: Type.Optional(Type.Record(Type.String(), Type.Any(), {
        description: "JSON arguments to pass to the upstream Slack MCP tool. Examples: {\"search_query\":\"weekly plan\"}, {\"channel_id\":\"#general\",\"limit\":\"20\"}, {\"channel_id\":\"#general\",\"thread_ts\":\"1234567890.123456\"}",
      })),
    }),
    async execute(_toolCallId, params) {
      const p = params as { tool?: unknown; args?: unknown; arguments?: unknown };
      let rawTool = String(p.tool ?? "").trim();
      if (!rawTool) return toolError("slack_mcp_call", "Missing required 'tool' parameter.");

      // Primary arg channel is `args`. We also keep accepting the old
      // `arguments` field for compatibility with early test sessions.
      let rawArgs = p.args ?? p.arguments ?? {};

      // Escape hatch for sessions whose already-sent tool schema only exposes
      // the `tool` string: allow `tool` to be `name { ...json args... }`.
      const inlineJson = rawTool.match(/^(\S+)\s+({[\s\S]*})$/);
      if (inlineJson && (rawArgs === undefined || (typeof rawArgs === "object" && rawArgs !== null && Object.keys(rawArgs as Record<string, unknown>).length === 0))) {
        rawTool = inlineJson[1];
        try {
          rawArgs = JSON.parse(inlineJson[2]) as Record<string, unknown>;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return toolError("slack_mcp_call", `Invalid inline JSON args after tool name: ${msg}`);
        }
      }

      if (typeof rawArgs === "string") {
        try {
          rawArgs = rawArgs.trim() ? JSON.parse(rawArgs) : {};
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return toolError("slack_mcp_call", `Invalid JSON in args string: ${msg}`);
        }
      }
      if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
        return toolError("slack_mcp_call", "args must be a JSON object.", { argsType: typeof rawArgs });
      }

      const result = client?.isConnected ? { ok: true as const } : await doConnect(notify);
      if (!result.ok) return toolError("slack_mcp_call", result.error);
      if (!client?.isConnected) return toolError("slack_mcp_call", "Not connected to Slack MCP.");

      const upstreamTool = rawTool.startsWith(cfg.toolPrefix) ? rawTool.slice(cfg.toolPrefix.length) : rawTool;
      if (cfg.disabledTools.has(upstreamTool)) {
        return toolError(
          "slack_mcp_call",
          `Slack tool '${cfg.toolPrefix}${upstreamTool}' is disabled by ${AUTH_FILE}. Remove it from disabledTools to call it.`,
          { upstreamTool },
        );
      }
      if (!client.getTools().some((tool) => tool.name === upstreamTool)) {
        const available = enabledSlackTools(client, cfg).map((tool) => `${cfg.toolPrefix}${tool.name}`);
        return toolError(
          "slack_mcp_call",
          `Unknown Slack MCP tool '${rawTool}'. Enabled tools: ${available.join(", ") || "(none)"}`,
          { upstreamTool, available },
        );
      }

      try {
        const args = rawArgs as Record<string, unknown>;
        const text = await client.callTool(upstreamTool, args);
        return toolResult("slack_mcp_call", text || "", { upstreamTool, calledAs: rawTool, args });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return toolError("slack_mcp_call", `Error calling ${upstreamTool}: ${msg}`, { upstreamTool, error: msg });
      }
    },
  });

  pi.registerTool({
    name: "slack_mcp_whoami",
    label: "Slack MCP Whoami",
    description:
      "Return the authenticated Slack user's identity (user_id, user, team, team_id, url) via auth.test. " +
      "Use the returned user_id with search modifiers like 'from:<user_id>' \u2014 the bare 'from:@me' " +
      "modifier is NOT supported by Slack search and silently returns zero results. No MCP connection required.",
    parameters: Type.Object({}),
    async execute() {
      const config = refreshConfig();
      if (!hasAuthEnv(config.env)) {
        return toolError("slack_mcp_whoami", `No Slack auth tokens found. Create ${AUTH_FILE} with a SLACK_MCP_XOXP_TOKEN (or XOXB, or XOXC+XOXD).`);
      }
      const id = await slackAuthTest(config.env);
      if (!id.ok) {
        return toolError("slack_mcp_whoami", `Slack auth.test failed: ${id.error ?? "unknown error"}`, { error: id.error });
      }
      const text = [
        `user_id: ${id.user_id}`,
        `user:    ${id.user}`,
        `team:    ${id.team} (${id.team_id})`,
        `url:     ${id.url}`,
        ``,
        `Tip: use 'from:${id.user_id}' (or 'to:${id.user_id}') in conversations_search_messages \u2014 'from:@me' does not work.`,
      ].join("\n");
      return toolResult("slack_mcp_whoami", text, {
        user_id: id.user_id,
        user: id.user,
        team: id.team,
        team_id: id.team_id,
        url: id.url,
      });
    },
  });

  pi.registerTool({
    name: "slack_mcp_status",
    label: "Slack MCP Status",
    description: "Check Slack MCP connection status and list available tools",
    parameters: Type.Object({}),
    async execute() {
      const refs = client ? sharedRefCount(client) : 0;
      const diagnostics = registryDiagnostics();
      return toolResult("slack_mcp_status", statusText(client, cfg, diagnostics), {
        connected: client?.isConnected ?? false,
        upstreamToolCount: client?.getTools().length ?? 0,
        enabledToolCount: enabledSlackTools(client, cfg).length,
        registeredToolCount: diagnostics.registeredToolNames?.length,
        activeToolCount: diagnostics.activeToolNames?.length,
        sharedRefs: refs,
      });
    },
  });

  // Clean shutdown when pi tears down ---------------------------------------
  // Releases this session's ref. If we were the last holder the underlying
  // child process is killed; if subagents (or another session) still hold
  // refs, the child stays alive for them.
  pi.on("session_shutdown", async () => {
    if (client) {
      const heldClient = client;
      client = null;
      await releaseClient(heldClient);
    }
  });

  // Optional auto-connect at startup (deferred so extension runtime is ready).
  // Skip if the sync fast-path already grabbed a ref — common case for
  // subagents whose parent had already connected.
  const rawCfg = loadConfig();
  if (!client && rawCfg?.autoConnect && hasAuthEnv(cfg.env)) {
    setTimeout(async () => {
      const result = await doConnect(notify);
      if (!result.ok) {
        console.warn(`[slack-mcp] autoConnect failed: ${result.error}`);
      }
    }, 0);
  }
}
