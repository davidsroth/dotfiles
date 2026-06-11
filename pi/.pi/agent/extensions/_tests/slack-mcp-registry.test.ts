/**
 * Tests for slack-mcp registry.ts, process-tracker.ts, and constants.ts.
 *
 * Hermetic: no real network, no real child processes, no reads of config files.
 *
 * NOTE: The stale-after-reload behaviour (registry.ts:30-57) is intentionally
 * untestable without real jiti re-import mechanics and is omitted by design.
 *
 * globalThis keys cleaned in beforeEach/afterEach to keep tests order-independent:
 *   __piSlackMCPSharedRegistry_v1__
 *   __piSlackMCPTrackedChildren_v1__
 *   __piSlackMCPExitHookInstalled_v1__
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// node:child_process must be mocked BEFORE process-tracker imports so the
// module closure captures the mock (vitest hoists vi.mock calls automatically).
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import {
  _getSharedRegistry,
  _configKey,
  peekConnectedShared,
  acquireExistingRef,
  acquireClient,
  releaseClient,
  sharedRefCount,
} from "../slack-mcp/registry";
import {
  trackedChildren,
  installExitHookOnce,
  killProcessTreeHard,
  _collectDescendants,
} from "../slack-mcp/process-tracker";
import { buildChildEnv } from "../slack-mcp/constants";
import type { ResolvedConfig } from "../slack-mcp/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REGISTRY_KEY = "__piSlackMCPSharedRegistry_v1__";
const TRACKED_KEY = "__piSlackMCPTrackedChildren_v1__";
const EXIT_HOOK_KEY = "__piSlackMCPExitHookInstalled_v1__";

function cleanGlobalThis() {
  const g = globalThis as Record<string, unknown>;
  delete g[REGISTRY_KEY];
  delete g[TRACKED_KEY];
  delete g[EXIT_HOOK_KEY];
}

function makeResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    command: "npx",
    args: ["-y", "slack-mcp-server@latest"],
    env: {},
    toolPrefix: "slack_",
    startupTimeoutMs: 60_000,
    requestTimeoutMs: 60_000,
    requestTimeoutMsByTool: {},
    postProcess: { enabled: true, dropColumns: new Set(), maxTextLength: 2000, resolveMentions: true },
    disabledTools: new Set(),
    ...overrides,
  };
}

/** A minimal fake StdioMCPClient for registry tests. */
class FakeClient {
  private _connected = false;
  disconnect = vi.fn(async () => {
    this._connected = false;
  });
  connect = vi.fn(async (_cfg: ResolvedConfig) => {
    this._connected = true;
  });
  get isConnected() {
    return this._connected;
  }
  setConnected(v: boolean) {
    this._connected = v;
  }
}

// ---------------------------------------------------------------------------
// Inject a FakeClient factory so acquireClient uses our fake instead of real
// StdioMCPClient. We do this by mocking the mcp-client module.
// We keep the most-recently constructed mock instance so tests can inspect
// its spies directly. The factory must be self-contained (no outer-scope refs
// to classes that aren't yet initialized when hoisting runs).
// ---------------------------------------------------------------------------

// These are module-level variables that the mock factory reads at runtime
// (not at hoist time), so they are safe to reference from within the factory.
let currentFakeClient: FakeClient;

interface IMockInstance {
  _connected: boolean;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  isConnected: boolean;
  setConnectedDirect(v: boolean): void;
}

let lastMockClientInstance: IMockInstance | null = null;

vi.mock("../slack-mcp/mcp-client", () => {
  return {
    StdioMCPClient: class {
      _connected = false;
      disconnect = vi.fn(async () => {
        (this as { _connected: boolean })._connected = false;
        // delegate to shared fake so tests can assert on it
        currentFakeClient.disconnect();
      });
      connect = vi.fn(async (cfg: ResolvedConfig) => {
        await currentFakeClient.connect(cfg);
        (this as { _connected: boolean })._connected = currentFakeClient.isConnected;
      });
      get isConnected() {
        return (this as { _connected: boolean })._connected;
      }
      setConnectedDirect(v: boolean) {
        (this as { _connected: boolean })._connected = v;
      }
      constructor() {
        // capture the instance after construction
        // biome-ignore lint: test-only side-effect
        lastMockClientInstance = this as unknown as IMockInstance;
      }
    },
  };
});

beforeEach(() => {
  cleanGlobalThis();
  currentFakeClient = new FakeClient();
  lastMockClientInstance = null;
  vi.clearAllMocks();
});

afterEach(() => {
  cleanGlobalThis();
  vi.restoreAllMocks();
});

// ===========================================================================
// registry.ts — getSharedRegistry bootstrap
// ===========================================================================
describe("registry-globalThis-bootstrap", () => {
  it("creates a new Map on first call", () => {
    const g = globalThis as Record<string, unknown>;
    expect(g[REGISTRY_KEY]).toBeUndefined();
    const reg = _getSharedRegistry();
    expect(reg).toBeInstanceOf(Map);
    expect(g[REGISTRY_KEY]).toBe(reg);
  });

  it("returns the same Map instance on subsequent calls", () => {
    const reg1 = _getSharedRegistry();
    const reg2 = _getSharedRegistry();
    expect(reg1).toBe(reg2);
  });

  it("creates a new Map after the key is deleted (fresh-module simulation)", () => {
    const reg1 = _getSharedRegistry();
    const g = globalThis as Record<string, unknown>;
    delete g[REGISTRY_KEY];
    const reg2 = _getSharedRegistry();
    expect(reg2).toBeInstanceOf(Map);
    expect(reg2).not.toBe(reg1);
  });
});

// ===========================================================================
// registry.ts — configKey
// ===========================================================================
describe("registry-configKey-excludes-toolPrefix", () => {
  it("two configs that differ only in toolPrefix produce the same key", () => {
    const cfg1 = makeResolvedConfig({ toolPrefix: "slack_" });
    const cfg2 = makeResolvedConfig({ toolPrefix: "slk_" });
    expect(_configKey(cfg1)).toBe(_configKey(cfg2));
  });

  it("different command produces a different key", () => {
    const cfg1 = makeResolvedConfig({ command: "npx" });
    const cfg2 = makeResolvedConfig({ command: "node" });
    expect(_configKey(cfg1)).not.toBe(_configKey(cfg2));
  });

  it("different args produces a different key", () => {
    const cfg1 = makeResolvedConfig({ args: ["-y", "server@latest"] });
    const cfg2 = makeResolvedConfig({ args: ["-y", "server@1.0.0"] });
    expect(_configKey(cfg1)).not.toBe(_configKey(cfg2));
  });

  it("different env produces a different key", () => {
    const cfg1 = makeResolvedConfig({ env: { SLACK_TOKEN: "abc" } });
    const cfg2 = makeResolvedConfig({ env: { SLACK_TOKEN: "xyz" } });
    expect(_configKey(cfg1)).not.toBe(_configKey(cfg2));
  });

  it("env key order is normalised (sorted)", () => {
    const cfg1 = makeResolvedConfig({ env: { Z: "1", A: "2" } });
    const cfg2 = makeResolvedConfig({ env: { A: "2", Z: "1" } });
    expect(_configKey(cfg1)).toBe(_configKey(cfg2));
  });
});

// ===========================================================================
// registry.ts — acquireClient: first-caller inserts synchronously
// ===========================================================================
describe("registry-acquireClient-first-caller-inserts-synchronously", () => {
  it("only one StdioMCPClient constructed for concurrent calls", async () => {
    const cfg = makeResolvedConfig();
    const [c1, c2] = await Promise.all([acquireClient(cfg), acquireClient(cfg)]);
    // Both should resolve to the same underlying client object
    expect(c1).toBe(c2);
  });

  it("sharedRefCount returns 2 after two concurrent acquires", async () => {
    const cfg = makeResolvedConfig();
    const [c1] = await Promise.all([acquireClient(cfg), acquireClient(cfg)]);
    expect(sharedRefCount(c1)).toBe(2);
  });

  it("entry is in registry synchronously before connect resolves", async () => {
    let registryChecked = false;
    // override connect to inspect registry mid-flight
    currentFakeClient.connect = vi.fn(async (_cfg) => {
      const reg = _getSharedRegistry();
      expect(reg.size).toBe(1);
      registryChecked = true;
      currentFakeClient.setConnected(true);
    });
    await acquireClient(makeResolvedConfig());
    expect(registryChecked).toBe(true);
  });

  it("concurrent callers sharing pending promise: connect rejects → both reject", async () => {
    const err = new Error("connect failed");
    currentFakeClient.connect = vi.fn(async () => {
      throw err;
    });
    const cfg = makeResolvedConfig();
    const p1 = acquireClient(cfg);
    const p2 = acquireClient(cfg);
    await expect(p1).rejects.toThrow("connect failed");
    await expect(p2).rejects.toThrow("connect failed");
  });

  it("registry entry is removed after concurrent connect failure", async () => {
    currentFakeClient.connect = vi.fn(async () => {
      throw new Error("boom");
    });
    const cfg = makeResolvedConfig();
    await Promise.allSettled([acquireClient(cfg), acquireClient(cfg)]);
    expect(_getSharedRegistry().size).toBe(0);
  });
});

// ===========================================================================
// registry.ts — acquireClient: connect failure ref cleanup
// ===========================================================================
describe("registry-acquireClient-connect-failure-ref-cleanup", () => {
  it("scenario A: single acquirer, connect fails — entry removed", async () => {
    const err = new Error("net error");
    currentFakeClient.connect = vi.fn(async () => {
      throw err;
    });
    const cfg = makeResolvedConfig();
    await expect(acquireClient(cfg)).rejects.toThrow("net error");
    expect(_getSharedRegistry().size).toBe(0);
  });

  it("scenario A: next call after failure creates a fresh entry", async () => {
    let calls = 0;
    currentFakeClient.connect = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("first attempt fails");
      currentFakeClient.setConnected(true);
    });
    const cfg = makeResolvedConfig();
    await expect(acquireClient(cfg)).rejects.toThrow();
    // second attempt should succeed (new entry / new client)
    const client = await acquireClient(cfg);
    expect(client).toBeDefined();
  });

  it("scenario B: two concurrent acquirers, connect fails — both reject, entry removed", async () => {
    currentFakeClient.connect = vi.fn(async () => {
      throw new Error("concurrent fail");
    });
    const cfg = makeResolvedConfig();
    const results = await Promise.allSettled([acquireClient(cfg), acquireClient(cfg)]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
    expect(_getSharedRegistry().size).toBe(0);
  });
});

// ===========================================================================
// registry.ts — releaseClient decrements and disconnects
// ===========================================================================
describe("registry-releaseClient-decrements-and-disconnects", () => {
  it("release once: refs decremented to 1, disconnect not called", async () => {
    const cfg = makeResolvedConfig();
    const c1 = await acquireClient(cfg);
    await acquireClient(cfg); // refs = 2
    expect(sharedRefCount(c1)).toBe(2);

    await releaseClient(c1);
    expect(sharedRefCount(c1)).toBe(1);
    expect(currentFakeClient.disconnect).not.toHaveBeenCalled();
    expect(_getSharedRegistry().size).toBe(1);
  });

  it("release twice: entry removed and disconnect called once", async () => {
    const cfg = makeResolvedConfig();
    const c1 = await acquireClient(cfg);
    await acquireClient(cfg); // refs = 2
    // make client appear connected so releaseClient calls disconnect
    lastMockClientInstance!.setConnectedDirect(true);

    await releaseClient(c1);
    await releaseClient(c1);
    expect(_getSharedRegistry().size).toBe(0);
    expect(currentFakeClient.disconnect).toHaveBeenCalledTimes(1);
  });

  it("double-release (third call): no-op, no error, disconnect not called again", async () => {
    const cfg = makeResolvedConfig();
    const c1 = await acquireClient(cfg);
    await acquireClient(cfg); // refs = 2
    lastMockClientInstance!.setConnectedDirect(true);
    await releaseClient(c1);
    await releaseClient(c1); // entry removed, disconnect x1
    // third release — should be a safe no-op
    await expect(releaseClient(c1)).resolves.toBeUndefined();
    expect(currentFakeClient.disconnect).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// registry.ts — releaseClient force bypasses refcount
// ===========================================================================
describe("registry-releaseClient-force-bypasses-refcount", () => {
  it("force=true removes entry and disconnects regardless of refs", async () => {
    const cfg = makeResolvedConfig();
    const c = await acquireClient(cfg);
    await acquireClient(cfg);
    await acquireClient(cfg); // refs = 3
    lastMockClientInstance!.setConnectedDirect(true);

    await releaseClient(c, { force: true });
    expect(_getSharedRegistry().size).toBe(0);
    expect(currentFakeClient.disconnect).toHaveBeenCalledTimes(1);
  });

  it("double-force: second call is a no-op (client not in registry)", async () => {
    const cfg = makeResolvedConfig();
    const c = await acquireClient(cfg);
    lastMockClientInstance!.setConnectedDirect(true);
    await releaseClient(c, { force: true });
    await expect(releaseClient(c, { force: true })).resolves.toBeUndefined();
    expect(currentFakeClient.disconnect).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// registry.ts — peekConnectedShared
// ===========================================================================
describe("registry-peekConnectedShared-returns-null-when-not-connected", () => {
  it("case 1: empty registry returns null", () => {
    expect(peekConnectedShared(makeResolvedConfig())).toBeNull();
  });

  it("case 2: entry present but isConnected=false returns null", async () => {
    // Don't mark connected after connect — simulate in-flight
    currentFakeClient.connect = vi.fn(async () => {
      // intentionally do NOT set connected=true
    });
    const cfg = makeResolvedConfig();
    // acquireClient will insert entry but isConnected stays false
    const p = acquireClient(cfg);
    // Even though entry is in registry, peek should return null because not connected
    const result = peekConnectedShared(cfg);
    expect(result).toBeNull();
    // Let the promise settle (it won't throw since connect didn't throw)
    await p.catch(() => {});
  });

  it("case 3: entry present and isConnected=true returns the client", async () => {
    const cfg = makeResolvedConfig();
    const client = await acquireClient(cfg);
    // isConnected should be true since connect set it
    const result = peekConnectedShared(cfg);
    expect(result).toBe(client);
  });
});

// ===========================================================================
// registry.ts — acquireExistingRef identity check
// ===========================================================================
describe("registry-acquireExistingRef-identity-check", () => {
  it("case 1: entry exists with matching client — returns true, refs incremented", async () => {
    const cfg = makeResolvedConfig();
    const client = await acquireClient(cfg);
    const before = sharedRefCount(client);
    const result = acquireExistingRef(cfg, client as never);
    expect(result).toBe(true);
    expect(sharedRefCount(client)).toBe(before + 1);
  });

  it("case 2: entry absent — returns false", () => {
    const fakeClient = new FakeClient();
    const result = acquireExistingRef(makeResolvedConfig(), fakeClient as never);
    expect(result).toBe(false);
  });

  it("case 3: entry exists but different client instance — returns false, refs unchanged", async () => {
    const cfg = makeResolvedConfig();
    const client = await acquireClient(cfg);
    const differentClient = new FakeClient();
    const before = sharedRefCount(client);
    const result = acquireExistingRef(cfg, differentClient as never);
    expect(result).toBe(false);
    expect(sharedRefCount(client)).toBe(before);
  });
});

// ===========================================================================
// process-tracker.ts — trackedChildren globalThis bootstrap
// ===========================================================================
describe("tracker-globalThis-bootstrap", () => {
  it("creates a new Set on first call", () => {
    const g = globalThis as Record<string, unknown>;
    expect(g[TRACKED_KEY]).toBeUndefined();
    const s = trackedChildren();
    expect(s).toBeInstanceOf(Set);
    expect(g[TRACKED_KEY]).toBe(s);
  });

  it("returns the same Set on subsequent calls", () => {
    const s1 = trackedChildren();
    const s2 = trackedChildren();
    expect(s1).toBe(s2);
  });

  it("data persists across calls", () => {
    trackedChildren().add(12345);
    expect(trackedChildren().has(12345)).toBe(true);
  });
});

// ===========================================================================
// process-tracker.ts — installExitHookOnce idempotent
// ===========================================================================
describe("tracker-installExitHookOnce-idempotent", () => {
  let originalOn: typeof process.on;
  let originalKill: typeof process.kill;
  let registeredReapAll: (() => void) | null;

  beforeEach(() => {
    cleanGlobalThis();
    registeredReapAll = null;
    originalOn = process.on.bind(process);
    originalKill = process.kill.bind(process);
    vi.spyOn(process, "on").mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "exit") {
        registeredReapAll = listener as () => void;
      }
      return process;
    }) as unknown as typeof process.on);
    vi.spyOn(process, "kill").mockImplementation((_pid: number, _signal?: string | number) => true);
  });

  afterEach(() => {
    process.on = originalOn;
    process.kill = originalKill;
    cleanGlobalThis();
  });

  it("installs process.on('exit') exactly once even when called twice", () => {
    installExitHookOnce();
    installExitHookOnce();
    const onSpy = process.on as ReturnType<typeof vi.fn>;
    const exitCalls = onSpy.mock.calls.filter(([event]) => event === "exit");
    expect(exitCalls).toHaveLength(1);
  });

  it("reapAll kills -pid and pid for each tracked PID, then clears the set", () => {
    installExitHookOnce();
    expect(registeredReapAll).not.toBeNull();

    trackedChildren().add(111);
    trackedChildren().add(222);

    registeredReapAll!();

    const killSpy = process.kill as ReturnType<typeof vi.fn>;
    const calls = killSpy.mock.calls;
    const targets = calls.map(([pid, sig]) => ({ pid, sig }));

    expect(targets).toContainEqual({ pid: -111, sig: "SIGKILL" });
    expect(targets).toContainEqual({ pid: 111, sig: "SIGKILL" });
    expect(targets).toContainEqual({ pid: -222, sig: "SIGKILL" });
    expect(targets).toContainEqual({ pid: 222, sig: "SIGKILL" });
    expect(targets).toHaveLength(4);
    expect(trackedChildren().size).toBe(0);
  });
});

// ===========================================================================
// process-tracker.ts — collectDescendants ps parsing (via _collectDescendants)
// ===========================================================================
describe("tracker-collectDescendants-ps-parsing", () => {
  beforeEach(() => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  it("case 1: linear chain root→A→B returns [A, B]", () => {
    // root=100, A=101, B=102
    const psOut = "100  1\n101 100\n102 101\n";
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(psOut);
    const result = _collectDescendants(100);
    expect(result).toContain(101);
    expect(result).toContain(102);
    expect(result).toHaveLength(2);
  });

  it("case 2: branching root→[A, B], A→[C] returns all three descendants", () => {
    const psOut = "100  1\n101 100\n102 100\n103 101\n";
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(psOut);
    const result = _collectDescendants(100);
    expect(result).toContain(101);
    expect(result).toContain(102);
    expect(result).toContain(103);
    expect(result).toHaveLength(3);
  });

  it("case 3: rootPid not in output returns []", () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue("999  1\n888 999\n");
    expect(_collectDescendants(100)).toEqual([]);
  });

  it("case 4: blank lines and header artifacts are skipped, valid lines parsed", () => {
    const psOut = "  PID  PPID\n\n  101 100\n\n  102 101\n";
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(psOut);
    const result = _collectDescendants(100);
    expect(result).toContain(101);
    expect(result).toContain(102);
  });

  it("case 5: execSync throws returns [] without propagating", () => {
    (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("ps failed");
    });
    expect(_collectDescendants(100)).toEqual([]);
  });

  it("case 6: execSync called with timeout=1000", () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue("");
    _collectDescendants(100);
    expect(execSync).toHaveBeenCalledWith(
      "ps -A -o pid=,ppid=",
      expect.objectContaining({ timeout: 1000 }),
    );
  });
});

// ===========================================================================
// process-tracker.ts — killProcessTreeHard three-stage strategy
// ===========================================================================
describe("tracker-killProcessTreeHard-three-stage-strategy", () => {
  beforeEach(() => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  it("kills -pid, pid, and each descendant in order", () => {
    // ps output: root=100 has descendants 101 and 102
    const psOut = "100  1\n101 100\n102 100\n";
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(psOut);

    killProcessTreeHard(100);

    const killSpy = process.kill as ReturnType<typeof vi.fn>;
    const calls = killSpy.mock.calls;
    expect(calls[0]).toEqual([-100, "SIGKILL"]);
    expect(calls[1]).toEqual([100, "SIGKILL"]);
    // descendants in some order
    const descendantCalls = calls.slice(2).map(([pid]) => pid);
    expect(descendantCalls).toContain(101);
    expect(descendantCalls).toContain(102);
  });

  it("does not throw when process.kill throws ESRCH for all calls", () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue("100  1\n101 100\n");
    (process.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const err = Object.assign(new Error("No such process"), { code: "ESRCH" });
      throw err;
    });
    expect(() => killProcessTreeHard(100)).not.toThrow();
  });
});

// ===========================================================================
// constants.ts — buildChildEnv allowlist filtering
// ===========================================================================
describe("constants-buildChildEnv-allowlist-filtering", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const testKeys = [
    "PATH", "HOME", "SLACK_MCP_XOXP_TOKEN", "NPM_CONFIG_CACHE",
    "ANTHROPIC_API_KEY", "CLAUDE_PERSONAL_ACCESS_TOKEN", "MY_SLACK_BAR", "SLACK_BAR",
    "npm_config_cache",
  ];

  beforeEach(() => {
    for (const k of testKeys) savedEnv[k] = process.env[k];
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_PERSONAL_ACCESS_TOKEN;
    delete process.env.MY_SLACK_BAR;
    delete process.env.SLACK_BAR;
    delete process.env.SLACK_MCP_XOXP_TOKEN;
    delete process.env.NPM_CONFIG_CACHE;
    delete process.env.npm_config_cache;
  });

  afterEach(() => {
    for (const k of testKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("PATH and HOME are forwarded when set", () => {
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/home/test";
    const out = buildChildEnv({});
    expect(out.PATH).toBe("/usr/bin:/bin");
    expect(out.HOME).toBe("/home/test");
  });

  it("SLACK_ prefix keys are forwarded", () => {
    process.env.SLACK_MCP_XOXP_TOKEN = "xoxp-token";
    const out = buildChildEnv({});
    expect(out.SLACK_MCP_XOXP_TOKEN).toBe("xoxp-token");
  });

  it("NPM_ prefix keys are forwarded", () => {
    process.env.NPM_CONFIG_CACHE = "/tmp/npm-cache";
    const out = buildChildEnv({});
    expect(out.NPM_CONFIG_CACHE).toBe("/tmp/npm-cache");
  });

  it("ANTHROPIC_API_KEY is excluded", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    const out = buildChildEnv({});
    expect(out).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("CLAUDE_PERSONAL_ACCESS_TOKEN is excluded", () => {
    process.env.CLAUDE_PERSONAL_ACCESS_TOKEN = "claude-secret";
    const out = buildChildEnv({});
    expect(out).not.toHaveProperty("CLAUDE_PERSONAL_ACCESS_TOKEN");
  });

  it("cfgEnv value overrides same-named allowlisted key", () => {
    process.env.PATH = "/usr/bin";
    const out = buildChildEnv({ PATH: "/custom/bin" });
    expect(out.PATH).toBe("/custom/bin");
  });

  it("cfgEnv can inject a key not in allowlist", () => {
    const out = buildChildEnv({ MY_CUSTOM_KEY: "custom_value" });
    expect(out.MY_CUSTOM_KEY).toBe("custom_value");
  });
});

// ===========================================================================
// constants.ts — buildChildEnv prefix matching exactness
// ===========================================================================
describe("constants-buildChildEnv-prefix-matching", () => {
  const saved: Record<string, string | undefined> = {};
  const testKeys = ["MY_SLACK_BAR", "SLACK_BAR", "npm_config_cache"];

  beforeEach(() => {
    for (const k of testKeys) saved[k] = process.env[k];
    delete process.env.MY_SLACK_BAR;
    delete process.env.SLACK_BAR;
    delete process.env.npm_config_cache;
  });

  afterEach(() => {
    for (const k of testKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("MY_SLACK_BAR is excluded (not exact SLACK_ prefix)", () => {
    process.env.MY_SLACK_BAR = "secret";
    const out = buildChildEnv({});
    expect(out).not.toHaveProperty("MY_SLACK_BAR");
  });

  it("SLACK_BAR is included (exact SLACK_ prefix)", () => {
    process.env.SLACK_BAR = "ok";
    const out = buildChildEnv({});
    expect(out.SLACK_BAR).toBe("ok");
  });

  it("npm_config_cache is included (lowercase npm_ prefix)", () => {
    process.env.npm_config_cache = "val";
    const out = buildChildEnv({});
    expect(out.npm_config_cache).toBe("val");
  });
});
