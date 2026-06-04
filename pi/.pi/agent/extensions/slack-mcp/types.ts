// =============================================================================
// Shared types for the Slack MCP extension
// =============================================================================

export interface SlackMCPConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  autoConnect?: boolean;
  toolPrefix?: string;
  startupTimeoutMs?: number;
  /**
   * Per-tool-call timeout in ms (applies to every `tools/call`). Default 60000.
   * Raise this for slow tools like `conversations_unreads` over many channels.
   */
  requestTimeoutMs?: number;
  /**
   * Per-upstream-tool timeout overrides (without toolPrefix), e.g.
   * { "conversations_unreads": 180000 }. Falls back to `requestTimeoutMs`.
   */
  requestTimeoutMsByTool?: Record<string, number>;
  /**
   * CSV output post-processing (token-trimming + readability). `false` disables
   * entirely; an object overrides individual knobs. See PostProcessConfig.
   */
  postProcess?: PostProcessConfig | boolean;
  /** Upstream tool names (without toolPrefix) to skip when registering with pi. */
  disabledTools?: string[];
}

/**
 * Post-processing applied to upstream CSV tool output (conversations_history,
 * conversations_replies, conversations_search_messages, channels_list, ...).
 * Safety: if the output doesn't parse as consistent CSV, it's passed through
 * unchanged. Every transform is individually configurable and reversible.
 */
export interface PostProcessConfig {
  /** Master switch. Default true. */
  enabled?: boolean;
  /**
   * CSV column names (header-row labels) to drop. Default drops the wide,
   * rarely-used columns. To keep e.g. Permalink, pass a list without it.
   * When `Cursor` is dropped, the last non-empty pagination cursor is
   * preserved as a `next_cursor: <value>` footer so pagination still works.
   */
  dropColumns?: string[];
  /** Truncate the `Text` column to this many chars (0 = no truncation). Default 800. */
  maxTextLength?: number;
  /** Resolve `<@U…>` / `<#C…>` mentions to @name / #name inline. Default true. */
  resolveMentions?: boolean;
}

export interface ResolvedPostProcess {
  enabled: boolean;
  dropColumns: Set<string>;
  maxTextLength: number;
  resolveMentions: boolean;
}

export interface ResolvedConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  toolPrefix: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  requestTimeoutMsByTool: Record<string, number>;
  postProcess: ResolvedPostProcess;
  /** Set of upstream tool names (without toolPrefix) to skip. */
  disabledTools: Set<string>;
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

export type ToolExecutionResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
};

export type NotifyLevel = "info" | "error";
export type NotifyFn = (message: string, type?: NotifyLevel) => void;
