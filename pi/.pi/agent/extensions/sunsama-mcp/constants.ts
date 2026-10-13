// =============================================================================
// Constants & defaults
// =============================================================================

import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_FILE = join(process.env.HOME || homedir(), ".pi", "agent", "sunsama-mcp.json");
export const CLAUDE_CODE_CONFIG_FILE = join(process.env.HOME || homedir(), ".claude.json");

export const DEFAULT_URL = "https://api.sunsama.com/mcp";
export const DEFAULT_TOOL_PREFIX = "tasks_";
export const DEFAULT_CLAUDE_MCP_SERVER_NAME = "tasks";
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Sunsama tools declared directly by default (the ones skills and ad-hoc sessions use most).
 * The other ~57 stay callable through tasks_mcp_call, which keeps ~25k tokens of tool
 * schemas out of every request.
 */
export const DEFAULT_DIRECT_TOOLS = [
  "create_task",
  "search_tasks",
  "get_task_by_id",
  "edit_task_title",
  "edit_task_notes",
  "append_task_notes",
  "mark_task_as_completed",
  "move_task_to_day",
  "move_task_to_backlog",
  "read_resource",
];
