// =============================================================================
// Shared types for the Sunsama MCP extension
// =============================================================================

export interface SunsamaMCPConfig {
  /** Streamable HTTP MCP endpoint. Defaults to Sunsama's hosted endpoint. */
  url?: string;
  /** Full Authorization header value, e.g. "Bearer ...". Prefer env/local config. */
  authorization?: string;
  /** Additional HTTP headers. Authorization here wins over `authorization`. */
  headers?: Record<string, string>;
  /** Auto-discover and register upstream tools when pi starts. Default true. */
  autoConnect?: boolean;
  /** Prefix for registered pi tools. Default "tasks_" to mirror Claude's server name. */
  toolPrefix?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  requestTimeoutMsByTool?: Record<string, number>;
  /** Upstream tool names (without toolPrefix) to skip when registering with pi. */
  disabledTools?: string[];
  /** Claude Code MCP server to import Authorization from when no pi config/env is set. Default "tasks". */
  claudeMcpServerName?: string;
}

export interface ResolvedConfig {
  url: string;
  headers: Record<string, string>;
  toolPrefix: string;
  autoConnect: boolean;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  requestTimeoutMsByTool: Record<string, number>;
  disabledTools: Set<string>;
  authSource: "env" | "pi-config" | "claude-code" | "missing";
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

export interface MCPCallTextResult {
  text: string;
  isError: boolean;
  raw: unknown;
}

export type ToolExecutionResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
};

export type NotifyLevel = "info" | "error";
export type NotifyFn = (message: string, type?: NotifyLevel) => void;
