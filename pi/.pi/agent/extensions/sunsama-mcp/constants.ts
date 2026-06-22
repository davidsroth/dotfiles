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
