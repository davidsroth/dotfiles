/**
 * Tests for StdioMCPClient (mcp-client.ts) and buildChildEnv (constants.ts).
 *
 * Hermetic: no real child processes, no real network, no real config files.
 * - spawn is injected via the optional _spawn param on connect() so each test
 *   gets its own fake child (EventEmitter + PassThrough stdio).
 * - process-tracker exports are mocked via vi.mock so no real signals fire.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock process-tracker BEFORE importing mcp-client so the module-level import
// in mcp-client.ts gets the mock version.
// ---------------------------------------------------------------------------
vi.mock("../slack-mcp/process-tracker", () => {
  const tracked = new Set<number>();
  return {
    trackedChildren: vi.fn(() => tracked),
    installExitHookOnce: vi.fn(),
    killProcessTreeHard: vi.fn(),
    _resetForTesting: () => tracked.clear(),
  };
});

// Also mock postprocess so tests that care about it can spy cleanly.
vi.mock("../slack-mcp/postprocess", () => ({
  postProcessCsv: vi.fn((_text: string, _pp: unknown, _env: unknown) => "postprocessed"),
}));

import { buildChildEnv, ENV_ALLOWLIST, ENV_ALLOWLIST_PREFIXES } from "../slack-mcp/constants";
import { StdioMCPClient } from "../slack-mcp/mcp-client";
import {
  _resetForTesting as resetTracker,
  installExitHookOnce,
  killProcessTreeHard,
  trackedChildren,
} from "../slack-mcp/process-tracker";
import { postProcessCsv } from "../slack-mcp/postprocess";
import type { ResolvedConfig } from "../slack-mcp/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ResolvedConfig for tests. */
function makeCfg(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    command: "npx",
    args: ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
    env: {},
    toolPrefix: "slack_",
    startupTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    requestTimeoutMsByTool: {},
    postProcess: {
      enabled: true,
      dropColumns: new Set(["Permalink"]),
      maxTextLength: 2000,
      resolveMentions: true,
    },
    disabledTools: new Set(),
    ...overrides,
  };
}

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough & { end: () => void };
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  kill: (sig?: string) => void;
}

/**
 * Build a fake ChildProcessWithoutNullStreams-compatible EventEmitter.
 * pid defaults to 12345 unless overridden.
 */
function makeFakeChild(pid = 12345): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;

  const stdin = new PassThrough();
  stdin.end = (() => { stdin.push(null); }) as unknown as typeof stdin.end;
  child.stdin = stdin as FakeChild["stdin"];

  child.stdout = new PassThrough();
  child.stdout.setEncoding("utf-8");
  child.stderr = new PassThrough();
  child.stderr.setEncoding("utf-8");

  child.kill = (sig = "SIGTERM") => {
    child.killed = true;
    setImmediate(() => child.emit("exit", null, sig));
  };

  return child;
}

type SpawnLike = (...args: unknown[]) => FakeChild;

function makeSpawn(child: FakeChild): SpawnLike {
  return vi.fn(() => child) as SpawnLike;
}

/** Write a JSON-RPC response object to a fake child's stdout. */
function respond(child: FakeChild, msg: object): void {
  child.stdout.push(JSON.stringify(msg) + "\n");
}

/** Perform the full connect handshake: drive the initialize + tools/list exchange. */
async function connectWithHandshake(
  client: StdioMCPClient,
  child: FakeChild,
  cfg: ResolvedConfig = makeCfg(),
  tools: Array<{ name: string; description?: string; inputSchema?: object }> = [],
): Promise<void> {
  // Start connect; it will block waiting for initialize response.
  const connectPromise = client.connect(cfg, makeSpawn(child) as unknown as Parameters<StdioMCPClient["connect"]>[1]);

  // Resolve initialize (id=1)
  await Promise.resolve(); // let event loop turn so listener is registered
  respond(child, { jsonrpc: "2.0", id: 1, result: { capabilities: {} } });

  // Resolve tools/list (id=2) – need a small delay for the notification to fire first
  await Promise.resolve();
  await Promise.resolve();
  respond(child, { jsonrpc: "2.0", id: 2, result: { tools } });

  await connectPromise;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  (resetTracker as () => void)();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ===========================================================================
// buildChildEnv — constants.ts
// ===========================================================================

describe("buildChildEnv — allowlist exact", () => {
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = process.env;
    // Replace process.env with a controlled object
    process.env = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/testuser",
      SLACK_BOT_TOKEN: "xoxb-test",
      NPM_CONFIG_CACHE: "/tmp/npm",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      CLAUDE_PERSONAL_ACCESS_TOKEN: "claude-secret",
    } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("includes exact-match allowlist keys (PATH, HOME)", () => {
    const out = buildChildEnv({});
    expect(out.PATH).toBe("/usr/bin:/bin");
    expect(out.HOME).toBe("/home/testuser");
  });

  it("includes SLACK_ prefixed keys", () => {
    const out = buildChildEnv({});
    expect(out.SLACK_BOT_TOKEN).toBe("xoxb-test");
  });

  it("includes NPM_ prefixed keys", () => {
    const out = buildChildEnv({});
    expect(out.NPM_CONFIG_CACHE).toBe("/tmp/npm");
  });

  it("excludes dangerous keys like ANTHROPIC_API_KEY", () => {
    const out = buildChildEnv({});
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("excludes CLAUDE_PERSONAL_ACCESS_TOKEN", () => {
    const out = buildChildEnv({});
    expect(out.CLAUDE_PERSONAL_ACCESS_TOKEN).toBeUndefined();
  });

  it("cfgEnv values appear even if absent from process.env", () => {
    const out = buildChildEnv({ SLACK_MCP_XOXP_TOKEN: "tok" });
    expect(out.SLACK_MCP_XOXP_TOKEN).toBe("tok");
  });

  it("cfgEnv wins over process.env for duplicate keys", () => {
    process.env.SLACK_BOT_TOKEN = "from-env";
    const out = buildChildEnv({ SLACK_BOT_TOKEN: "from-cfg" });
    expect(out.SLACK_BOT_TOKEN).toBe("from-cfg");
  });
});

describe("buildChildEnv — prefix matching", () => {
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = process.env;
    process.env = {
      npm_lifecycle_event: "test",
      NPM_CONFIG_CACHE: "/npm",
      SLACK_BOT_TOKEN: "xoxb-123",
      MY_SLACK_EXTRA: "should-not-pass",
      FOO_NPM_BAR: "should-not-pass",
    } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("passes npm_ prefixed keys (lowercase)", () => {
    expect(buildChildEnv({}).npm_lifecycle_event).toBe("test");
  });

  it("passes NPM_ prefixed keys (uppercase)", () => {
    expect(buildChildEnv({}).NPM_CONFIG_CACHE).toBe("/npm");
  });

  it("passes SLACK_ prefixed keys", () => {
    expect(buildChildEnv({}).SLACK_BOT_TOKEN).toBe("xoxb-123");
  });

  it("does not pass keys that merely contain SLACK_ in the middle", () => {
    expect(buildChildEnv({}).MY_SLACK_EXTRA).toBeUndefined();
  });

  it("does not pass keys that merely contain NPM_ in the middle", () => {
    expect(buildChildEnv({}).FOO_NPM_BAR).toBeUndefined();
  });
});

describe("buildChildEnv — cfgEnv wins", () => {
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = process.env;
    process.env = { SLACK_FOO: "from-env" } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("cfgEnv value overwrites colliding allowlist key", () => {
    const out = buildChildEnv({ SLACK_FOO: "from-cfg" });
    expect(out.SLACK_FOO).toBe("from-cfg");
  });
});

describe("ENV_ALLOWLIST and ENV_ALLOWLIST_PREFIXES exports", () => {
  it("ENV_ALLOWLIST contains PATH", () => {
    expect(ENV_ALLOWLIST).toContain("PATH");
  });

  it("ENV_ALLOWLIST contains HOME", () => {
    expect(ENV_ALLOWLIST).toContain("HOME");
  });

  it("ENV_ALLOWLIST_PREFIXES contains NPM_, npm_, SLACK_", () => {
    expect(ENV_ALLOWLIST_PREFIXES).toContain("NPM_");
    expect(ENV_ALLOWLIST_PREFIXES).toContain("npm_");
    expect(ENV_ALLOWLIST_PREFIXES).toContain("SLACK_");
  });
});

// ===========================================================================
// StdioMCPClient — connect behaviors
// ===========================================================================

describe("connect — success path sets isConnected and getTools", () => {
  it("isConnected becomes true after full handshake", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    expect(client.isConnected).toBe(false);

    await connectWithHandshake(client, child, makeCfg(), [
      { name: "channels_list", description: "List channels", inputSchema: { type: "object" } },
    ]);

    expect(client.isConnected).toBe(true);
    expect(client.getTools()).toHaveLength(1);
    expect(client.getTools()[0].name).toBe("channels_list");
  });

  it("isConnected is false on a new instance", () => {
    expect(new StdioMCPClient().isConnected).toBe(false);
  });
});

describe("connect — idempotent", () => {
  it("second connect() is a no-op, spawn called once", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    const spawnFn = makeSpawn(child);

    const cfg = makeCfg();
    const connectPromise = client.connect(cfg, spawnFn as unknown as Parameters<StdioMCPClient["connect"]>[1]);
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    await Promise.resolve();
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 2, result: { tools: [] } });
    await connectPromise;

    // Second connect call — should be a no-op
    await client.connect(cfg, spawnFn as unknown as Parameters<StdioMCPClient["connect"]>[1]);

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(client.isConnected).toBe(true);
  });
});

describe("connect — exit during handshake", () => {
  it("rejects with 'exited' message when child exits before initialize response", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    const spawnFn = makeSpawn(child);

    const cfg = makeCfg({ startupTimeoutMs: 30000 });
    const connectPromise = client.connect(cfg, spawnFn as unknown as Parameters<StdioMCPClient["connect"]>[1]);

    await Promise.resolve();
    // Emit exit before any response
    child.emit("exit", 1, null);

    await expect(connectPromise).rejects.toThrow(/exited/);
    expect(client.isConnected).toBe(false);
  });
});

describe("connect — exit during handshake kills child (orphan prevention)", () => {
  it("calls killProcessTreeHard with child pid on connect failure", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild(12345);
    const spawnFn = makeSpawn(child);

    const cfg = makeCfg({ startupTimeoutMs: 30000 });
    const connectPromise = client.connect(cfg, spawnFn as unknown as Parameters<StdioMCPClient["connect"]>[1]);

    await Promise.resolve();
    child.emit("exit", 1, null);

    await expect(connectPromise).rejects.toThrow();
    expect(killProcessTreeHard).toHaveBeenCalledWith(12345);
  });

  it("calls trackedChildren().delete with child pid on connect failure", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild(12345);
    const spawnFn = makeSpawn(child);

    const cfg = makeCfg({ startupTimeoutMs: 30000 });
    const connectPromise = client.connect(cfg, spawnFn as unknown as Parameters<StdioMCPClient["connect"]>[1]);

    await Promise.resolve();
    child.emit("exit", 1, null);

    await expect(connectPromise).rejects.toThrow();
    const tc = trackedChildren();
    // After the cleanup path, pid 12345 should not be tracked
    expect(tc.has(12345)).toBe(false);
  });
});

describe("connect — startup timeout", () => {
  it("rejects with timeout message when initialize never arrives", async () => {
    vi.useFakeTimers();
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    const spawnFn = makeSpawn(child);

    const cfg = makeCfg({ startupTimeoutMs: 50 });
    const connectPromise = client.connect(cfg, spawnFn as unknown as Parameters<StdioMCPClient["connect"]>[1]);

    await Promise.resolve();
    vi.advanceTimersByTime(100);
    // Flush promises
    await Promise.resolve();
    await Promise.resolve();

    await expect(connectPromise).rejects.toThrow(/timed out after 50ms/);
    expect(client.isConnected).toBe(false);
  });
});

describe("connect — pid tracking", () => {
  it("adds child.pid to trackedChildren on successful connect", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild(99999);
    await connectWithHandshake(client, child);
    expect(trackedChildren().has(99999)).toBe(true);
  });

  it("calls installExitHookOnce before spawn", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);
    expect(installExitHookOnce).toHaveBeenCalled();
  });
});

// ===========================================================================
// JSON-RPC request/response correlation
// ===========================================================================

describe("jsonrpc — request/response correlation", () => {
  it("correlates responses by id, not order of receipt", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    // IDs 1 and 2 consumed by handshake; next two are 3 and 4.
    const p3 = (client as unknown as { request: (m: string, p: Record<string, unknown>, t: number) => Promise<unknown> })
      // Access request via callTool indirection instead — we use callTool which uses id 3
      ;

    // Use callTool to fire two requests (id=3 and id=4)
    const result3Promise = client.callTool("tool_a", { _raw: true });
    const result4Promise = client.callTool("tool_b", { _raw: true });

    await Promise.resolve();

    // Respond to id=4 first, then id=3
    respond(child, { jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "result-for-4" }] } });
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "result-for-3" }] } });

    const [r3, r4] = await Promise.all([result3Promise, result4Promise]);
    expect(r3).toBe("result-for-3");
    expect(r4).toBe("result-for-4");
  });
});

describe("jsonrpc — request timeout", () => {
  it("rejects with timed out message after timeoutMs elapses", async () => {
    vi.useFakeTimers();
    const client = new StdioMCPClient();
    const child = makeFakeChild();

    // Connect with fake timers: drive handshake manually
    const cfg = makeCfg({ startupTimeoutMs: 5000, requestTimeoutMs: 100 });
    const connectPromise = client.connect(cfg, makeSpawn(child) as unknown as Parameters<StdioMCPClient["connect"]>[1]);

    // Respond to handshake synchronously to avoid startup timeout
    respond(child, { jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    await Promise.resolve();
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 2, result: { tools: [] } });
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await connectPromise;

    const toolPromise = client.callTool("slow_tool", { _raw: true });
    vi.advanceTimersByTime(200);
    await Promise.resolve();

    await expect(toolPromise).rejects.toThrow(/timed out after 100ms/);
    expect(client.pendingCount).toBe(0);
  });
});

describe("jsonrpc — error response", () => {
  it("rejects with MCP error message on error response", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    const p = client.callTool("my_tool", { _raw: true });
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Method not found" } });

    await expect(p).rejects.toThrow("MCP error -32601: Method not found");
  });
});

describe("jsonrpc — invalid JSON does not crash", () => {
  it("skips bad JSON and processes subsequent lines", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    const p = client.callTool("my_tool", { _raw: true });
    await Promise.resolve();

    // Push invalid JSON followed by valid response for id=3
    child.stdout.push("not-json\n");
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "ok" }] } });

    const result = await p;
    expect(result).toBe("ok");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"));
  });
});

describe("jsonrpc — newline framing buffer", () => {
  it("reassembles a response split across two data events", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    const p = client.callTool("my_tool", { _raw: true });
    await Promise.resolve();

    const full = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "split-ok" }] } }) + "\n";
    const mid = Math.floor(full.length / 2);
    child.stdout.push(full.slice(0, mid));
    await Promise.resolve();
    child.stdout.push(full.slice(mid));
    await Promise.resolve();

    expect(await p).toBe("split-ok");
  });
});

describe("jsonrpc — server notification ignored", () => {
  it("does not crash or change state when receiving notification without id", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    child.stdout.push(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} }) + "\n");
    await Promise.resolve();

    expect(client.isConnected).toBe(true);
    expect(client.pendingCount).toBe(0);
  });
});

// ===========================================================================
// callTool behaviors
// ===========================================================================

describe("callTool — strips _raw and _maxTextLength from forwarded args", () => {
  it("does not forward _raw or _maxTextLength in the JSON-RPC request", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    // Intercept stdin writes by spying on the write method directly.
    const stdinWrites: string[] = [];
    const origWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((...args: unknown[]) => {
      stdinWrites.push(String(args[0]));
      return origWrite(...(args as Parameters<typeof origWrite>));
    }) as typeof child.stdin.write;

    const p = client.callTool("my_tool", { _raw: true, _maxTextLength: 100, channel: "C123" });
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "x" }] } });
    await p;

    // Find the tools/call request (after the handshake writes)
    const toolsCallLine = stdinWrites.find((w) => w.includes('"tools/call"'));
    expect(toolsCallLine).toBeDefined();
    const parsed = JSON.parse(toolsCallLine!.trim());
    expect(parsed.params.arguments).toEqual({ channel: "C123" });
    expect(parsed.params.arguments._raw).toBeUndefined();
    expect(parsed.params.arguments._maxTextLength).toBeUndefined();
  });
});

describe("callTool — _raw bypasses postprocess", () => {
  it("returns raw text without calling postProcessCsv when _raw=true", async () => {
    vi.mocked(postProcessCsv).mockResolvedValue("postprocessed");
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    const p = client.callTool("my_tool", { _raw: true });
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "raw,csv,data" }] } });

    const result = await p;
    expect(result).toBe("raw,csv,data");
    expect(postProcessCsv).not.toHaveBeenCalled();
  });
});

describe("callTool — _maxTextLength override", () => {
  it("calls postProcessCsv with overridden maxTextLength", async () => {
    vi.mocked(postProcessCsv).mockResolvedValue("pp-result");
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child, makeCfg({
      postProcess: { enabled: true, dropColumns: new Set(), maxTextLength: 2000, resolveMentions: false },
    }));

    const p = client.callTool("my_tool", { _maxTextLength: 0 });
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "csv" }] } });
    await p;

    expect(postProcessCsv).toHaveBeenCalledWith(
      "csv",
      expect.objectContaining({ maxTextLength: 0 }),
      expect.anything(),
    );
  });
});

describe("callTool — per-tool timeout", () => {
  it("uses requestTimeoutMsByTool for named tool, stays alive past default", async () => {
    vi.useFakeTimers();

    const client = new StdioMCPClient();
    const child = makeFakeChild();

    const cfg = makeCfg({
      startupTimeoutMs: 9999999,
      requestTimeoutMs: 60000,
      requestTimeoutMsByTool: { slow_tool: 180000 },
    });

    // Drive handshake with fake timers
    const connectPromise = client.connect(cfg, makeSpawn(child) as unknown as Parameters<StdioMCPClient["connect"]>[1]);
    respond(child, { jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    await Promise.resolve();
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 2, result: { tools: [] } });
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await connectPromise;

    const toolPromise = client.callTool("slow_tool", { _raw: true });

    // Advance past default timeout (60s) but not per-tool (180s)
    vi.advanceTimersByTime(100000);
    await Promise.resolve();

    // Should still be pending
    let settled = false;
    toolPromise.then(() => { settled = true; }).catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Advance past per-tool timeout
    vi.advanceTimersByTime(90000);
    await Promise.resolve();

    await expect(toolPromise).rejects.toThrow(/timed out after 180000ms/);
  });
});

describe("callTool — empty result", () => {
  it("returns empty string when RPC result is undefined/null", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    const p = client.callTool("my_tool", { _raw: true });
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 3, result: null });

    expect(await p).toBe("");
  });
});

describe("callTool — non-array content", () => {
  it("JSON.stringifies the entire result when content is not an array", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    const p = client.callTool("my_tool", { _raw: true });
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 3, result: { someKey: "val" } });

    expect(await p).toBe(JSON.stringify({ someKey: "val" }));
  });
});

// ===========================================================================
// disconnect behaviors
// ===========================================================================

describe("disconnect — kills process tree after SIGKILL delay", () => {
  it("calls killProcessTreeHard(pid) after DISCONNECT_SIGKILL_DELAY_MS (500ms)", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const client = new StdioMCPClient();
    const child = makeFakeChild(12345);

    const cfg = makeCfg({ startupTimeoutMs: 9999999 });
    const connectPromise = client.connect(cfg, makeSpawn(child) as unknown as Parameters<StdioMCPClient["connect"]>[1]);
    respond(child, { jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    await Promise.resolve();
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 2, result: { tools: [] } });
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await connectPromise;

    const disconnectPromise = client.disconnect();

    // Emit exit to allow disconnect to resolve
    await Promise.resolve();
    child.emit("exit", 0, null);

    vi.advanceTimersByTime(600);
    await Promise.resolve();
    await disconnectPromise;

    expect(killProcessTreeHard).toHaveBeenCalledWith(12345);
    killSpy.mockRestore();
  });

  it("calls trackedChildren().delete(pid) during disconnect", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => true);

    const client = new StdioMCPClient();
    const child = makeFakeChild(12345);

    const cfg = makeCfg({ startupTimeoutMs: 9999999 });
    const connectPromise = client.connect(cfg, makeSpawn(child) as unknown as Parameters<StdioMCPClient["connect"]>[1]);
    respond(child, { jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    await Promise.resolve();
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 2, result: { tools: [] } });
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await connectPromise;

    const disconnectPromise = client.disconnect();
    await Promise.resolve();
    child.emit("exit", 0, null);
    vi.advanceTimersByTime(600);
    await Promise.resolve();
    await disconnectPromise;

    expect(trackedChildren().has(12345)).toBe(false);
  });
});

describe("disconnect — hard timeout", () => {
  it("resolves disconnect and calls killProcessTreeHard if child never exits (2000ms)", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => true);

    const client = new StdioMCPClient();
    const child = makeFakeChild(12345);

    const cfg = makeCfg({ startupTimeoutMs: 9999999 });
    const connectPromise = client.connect(cfg, makeSpawn(child) as unknown as Parameters<StdioMCPClient["connect"]>[1]);
    respond(child, { jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    await Promise.resolve();
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 2, result: { tools: [] } });
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await connectPromise;

    // Do NOT emit exit — child stays alive
    const disconnectPromise = client.disconnect();
    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    await Promise.resolve();

    await expect(disconnectPromise).resolves.toBeUndefined();
    expect(killProcessTreeHard).toHaveBeenCalledWith(12345);
  });
});

describe("disconnect — rejects pending requests", () => {
  it("pending requests reject with Disconnected message", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => true);

    const client = new StdioMCPClient();
    const child = makeFakeChild();

    const cfg = makeCfg({ startupTimeoutMs: 9999999, requestTimeoutMs: 9999999 });
    const connectPromise = client.connect(cfg, makeSpawn(child) as unknown as Parameters<StdioMCPClient["connect"]>[1]);
    respond(child, { jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    await Promise.resolve();
    await Promise.resolve();
    respond(child, { jsonrpc: "2.0", id: 2, result: { tools: [] } });
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    await connectPromise;

    // Start a request but never respond
    const pendingRequest = client.callTool("my_tool", { _raw: true });
    await Promise.resolve();

    // Disconnect; child never emits exit so hard timeout fires at 2000ms
    const disconnectPromise = client.disconnect();
    await Promise.resolve();
    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    await Promise.resolve();
    await disconnectPromise;

    await expect(pendingRequest).rejects.toThrow("Disconnected");
  });
});

describe("disconnect — clears connected and tools immediately", () => {
  it("isConnected becomes false and getTools returns [] right after disconnect() called", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child, makeCfg(), [
      { name: "channels_list", description: "list", inputSchema: {} },
    ]);

    vi.spyOn(process, "kill").mockImplementation(() => true);

    const disconnectPromise = client.disconnect();
    // Check synchronously after the call (before awaiting)
    expect(client.isConnected).toBe(false);
    expect(client.getTools()).toEqual([]);

    child.emit("exit", 0, null);
    await disconnectPromise;
  });
});

// ===========================================================================
// Exit event during operation
// ===========================================================================

describe("exit event during operation", () => {
  it("rejects in-flight requests when child exits unexpectedly", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    const p = client.callTool("my_tool", { _raw: true });
    await Promise.resolve();

    child.emit("exit", 137, null);
    await Promise.resolve();

    await expect(p).rejects.toThrow(/exited \(code=137/);
    expect(client.isConnected).toBe(false);
  });
});

// ===========================================================================
// write throws when not connected
// ===========================================================================

describe("write — throws when not connected", () => {
  it("callTool rejects with Not connected to MCP server on fresh client", async () => {
    const client = new StdioMCPClient();
    await expect(client.callTool("any_tool", {})).rejects.toThrow("Not connected to MCP server");
  });
});

// ===========================================================================
// isConnected semantics across state transitions
// ===========================================================================

describe("isConnected semantics", () => {
  it("is false on new instance", () => {
    expect(new StdioMCPClient().isConnected).toBe(false);
  });

  it("is false after failed connect (exit during handshake)", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    const p = client.connect(makeCfg({ startupTimeoutMs: 30000 }), makeSpawn(child) as unknown as Parameters<StdioMCPClient["connect"]>[1]);
    await Promise.resolve();
    child.emit("exit", 1, null);
    await p.catch(() => {});
    expect(client.isConnected).toBe(false);
  });

  it("is false after disconnect", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    vi.spyOn(process, "kill").mockImplementation(() => true);

    await connectWithHandshake(client, child);
    const dp = client.disconnect();
    child.emit("exit", 0, null);
    await dp;
    expect(client.isConnected).toBe(false);
  });

  it("is false after unexpected child exit", async () => {
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    child.emit("exit", 137, null);
    await Promise.resolve();

    expect(client.isConnected).toBe(false);
  });
});

// ===========================================================================
// stderr filtering
// ===========================================================================

describe("stderr filtering", () => {
  it("suppresses npm warn lines", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    warnSpy.mockClear();
    child.stderr.push("npm warn deprecated pkg\n");
    await Promise.resolve();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("npm warn"));
  });

  it("suppresses JSON info log lines", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    warnSpy.mockClear();
    child.stderr.push('{"level":"info","msg":"x"}\n');
    await Promise.resolve();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("suppresses [slack-mcp] tagged lines", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    warnSpy.mockClear();
    child.stderr.push("[slack-mcp] info about something\n");
    await Promise.resolve();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("surfaces unrecognized errors with [slack-mcp] prefix", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    warnSpy.mockClear();
    child.stderr.push("unrecognized error from server\n");
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[slack-mcp\] unrecognized error/));
  });

  it("suppresses empty/whitespace-only stderr lines", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new StdioMCPClient();
    const child = makeFakeChild();
    await connectWithHandshake(client, child);

    warnSpy.mockClear();
    child.stderr.push("   \n");
    await Promise.resolve();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
