import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpMCPClient } from "../sunsama-mcp/http-client";
import type { ResolvedConfig } from "../sunsama-mcp/types";

function makeCfg(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer test" },
    toolPrefix: "tasks_",
    autoConnect: true,
    startupTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    requestTimeoutMsByTool: {},
    disabledTools: new Set(),
    authSource: "env",
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpMCPClient", () => {
  it("initializes, sends initialized notification, and lists tools", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      if (payload.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { serverInfo: { name: "Sunsama" } } });
      }
      if (payload.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (payload.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: payload.id,
          result: { tools: [{ name: "create_task", description: "Create", inputSchema: { type: "object", properties: {} } }] },
        });
      }
      throw new Error(`unexpected method ${payload.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpMCPClient();
    await client.connect(makeCfg());

    expect(client.isConnected).toBe(true);
    expect(client.getTools()).toEqual([{ name: "create_task", description: "Create", inputSchema: { type: "object", properties: {} } }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer test" });
  });

  it("calls tools and preserves MCP isError", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      if (payload.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: {} });
      if (payload.method === "notifications/initialized") return new Response("", { status: 202 });
      if (payload.method === "tools/list") return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { tools: [] } });
      if (payload.method === "tools/call") {
        expect(payload.params).toEqual({ name: "search_tasks", arguments: { searchTerm: "foo" } });
        return jsonResponse({
          jsonrpc: "2.0",
          id: payload.id,
          result: { isError: true, content: [{ type: "text", text: "bad search" }] },
        });
      }
      throw new Error(`unexpected method ${payload.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpMCPClient();
    await client.connect(makeCfg());
    const result = await client.callTool("search_tasks", { searchTerm: "foo" });

    expect(result).toMatchObject({ text: "bad search", isError: true });
  });

  it("parses SSE JSON-RPC responses", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      if (payload.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: {} });
      if (payload.method === "notifications/initialized") return new Response("", { status: 202 });
      if (payload.method === "tools/list") return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { tools: [] } });
      if (payload.method === "tools/call") {
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: "from sse" }] } })}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected method ${payload.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpMCPClient();
    await client.connect(makeCfg());

    await expect(client.callTool("any", {})).resolves.toMatchObject({ text: "from sse", isError: false });
  });
});
