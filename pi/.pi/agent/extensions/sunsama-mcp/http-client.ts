// =============================================================================
// Streamable HTTP MCP client
// =============================================================================

import type { JsonRpcResponse, MCPCallTextResult, MCPTool, ResolvedConfig } from "./types";

export class HttpMCPClient {
  private nextId = 1;
  private tools: MCPTool[] = [];
  private connected = false;
  private sessionId: string | null = null;
  private cfg: ResolvedConfig | null = null;

  get isConnected(): boolean {
    return this.connected;
  }

  getTools(): MCPTool[] {
    return this.tools;
  }

  async connect(cfg: ResolvedConfig): Promise<void> {
    this.cfg = cfg;
    this.sessionId = null;
    this.connected = false;

    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-sunsama-mcp", version: "1.0.0" },
      },
      cfg.startupTimeoutMs,
    );
    await this.notify("notifications/initialized", {});

    const listResult = (await this.request("tools/list", {}, cfg.startupTimeoutMs)) as { tools?: MCPTool[] } | undefined;
    this.tools = (listResult?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
    this.tools = [];
    this.sessionId = null;
    this.cfg = null;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MCPCallTextResult> {
    if (!this.cfg) throw new Error("Not connected to Sunsama MCP");
    const timeoutMs = this.cfg.requestTimeoutMsByTool[name] ?? this.cfg.requestTimeoutMs;
    const result = (await this.request("tools/call", { name, arguments: args }, timeoutMs, signal)) as
      | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      | undefined;
    if (!result) return { text: "", isError: false, raw: result };
    const content = result.content;
    let text: string;
    if (Array.isArray(content)) {
      text = content.map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c))).join("\n");
    } else {
      text = JSON.stringify(result);
    }
    return { text, isError: result.isError === true, raw: result };
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.postJson({ jsonrpc: "2.0", method, params }, this.cfg?.startupTimeoutMs ?? 10_000);
    } catch (error) {
      // Notifications are best-effort; some HTTP MCP servers reply 202 with no body.
      console.warn(`[sunsama-mcp] notification ${method} failed: ${(error as Error).message}`);
    }
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.postJson({ jsonrpc: "2.0", id, method, params }, timeoutMs, signal);
    if (response.error) throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
    return response.result;
  }

  private async postJson(payload: object, timeoutMs: number, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (!this.cfg) throw new Error("Missing Sunsama MCP config");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", abortFromCaller, { once: true });
    }

    try {
      const headers: Record<string, string> = {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2024-11-05",
        ...this.cfg.headers,
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

      const res = await fetch(this.cfg.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} from Sunsama MCP${body ? `: ${body.slice(0, 500)}` : ""}`);
      }
      if (res.status === 202) return { jsonrpc: "2.0" };

      const text = await res.text();
      if (!text.trim()) return { jsonrpc: "2.0" };
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") || text.startsWith("event:")) {
        return parseSseJsonRpc(text);
      }
      return JSON.parse(text) as JsonRpcResponse;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(`MCP HTTP request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", abortFromCaller);
    }
  }
}

function parseSseJsonRpc(text: string): JsonRpcResponse {
  const events = text.split(/\r?\n\r?\n/);
  for (const event of events) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") continue;
    return JSON.parse(data) as JsonRpcResponse;
  }
  throw new Error("No JSON-RPC data event found in MCP SSE response");
}
