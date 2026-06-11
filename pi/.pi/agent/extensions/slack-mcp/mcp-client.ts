// =============================================================================
// Stdio MCP client
// =============================================================================

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  buildChildEnv,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DISCONNECT_HARD_TIMEOUT_MS,
  DISCONNECT_SIGKILL_DELAY_MS,
} from "./constants";
import { resolvePostProcess } from "./config";
import { postProcessCsv } from "./postprocess";
import { installExitHookOnce, killProcessTreeHard, trackedChildren } from "./process-tracker";
import type { JsonRpcResponse, MCPTool, ResolvedConfig, ResolvedPostProcess } from "./types";

export class StdioMCPClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private tools: MCPTool[] = [];
  private connected = false;
  // Per-tool-call timeout, populated from ResolvedConfig at connect() time.
  private requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  private requestTimeoutMsByTool: Record<string, number> = {};
  // CSV post-processing config + auth env, populated at connect() time.
  private postProcess: ResolvedPostProcess = resolvePostProcess(undefined);
  private authEnv: Record<string, string> = {};

  get isConnected(): boolean {
    return this.connected;
  }

  /** @internal test-only: number of in-flight pending requests */
  get pendingCount(): number {
    return this.pending.size;
  }

  getTools(): MCPTool[] {
    return this.tools;
  }

  private killProcessGroup(child: ChildProcessWithoutNullStreams): void {
    const childPid = child.pid;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    if (childPid === undefined) return;
    // Fast and unconditional: connect-failure path doesn't need to be polite.
    killProcessTreeHard(childPid);
    trackedChildren().delete(childPid);
  }

  async connect(cfg: ResolvedConfig, _spawn?: typeof spawn): Promise<void> {
    if (this.connected) return;
    this.requestTimeoutMs = cfg.requestTimeoutMs;
    this.requestTimeoutMsByTool = cfg.requestTimeoutMsByTool;
    this.postProcess = cfg.postProcess;
    this.authEnv = cfg.env;

    // Ensure the at-exit reaper is registered before we spawn anything.
    installExitHookOnce();

    const spawnFn = _spawn ?? spawn;
    const env = buildChildEnv(cfg.env);
    const child = spawnFn(cfg.command, cfg.args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Put the child in its own process group so we can SIGTERM/SIGKILL the
      // whole tree (npm exec -> node -> Go binary). Without this, killing the
      // top-level npm leaves the node and Go grandchildren orphaned.
      detached: true,
    });
    this.child = child;
    if (child.pid !== undefined) {
      trackedChildren().add(child.pid);
      // Best-effort: drop from the tracker when the immediate child exits.
      // (Grandchildren may outlive this event, hence the explicit kill in
      // disconnect() and the at-exit reaper.)
      child.once("exit", () => {
        if (child.pid !== undefined) trackedChildren().delete(child.pid);
      });
    }

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      // Surface server logs to the pi log, but suppress routine noise
      const trimmed = chunk.trim();
      if (!trimmed) return;
      // Skip npm warnings and verbose Slack MCP JSON info logs
      if (trimmed.startsWith("npm warn")) return;
      if (trimmed.startsWith('{"level":"info"')) return;
      if (trimmed.startsWith("[slack-mcp]")) return; // already tagged
      console.warn(`[slack-mcp] ${trimmed}`);
    });

    const exitPromise = new Promise<never>((_resolve, reject) => {
      child.once("exit", (code, signal) => {
        const err = new Error(`Slack MCP server exited (code=${code} signal=${signal ?? "none"})`);
        // Reject all pending requests
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        this.connected = false;
        this.child = null;
        reject(err);
      });
      child.once("error", (err) => {
        this.connected = false;
        this.child = null;
        reject(err);
      });
    });
    // Don't let the unhandled-rejection eat us if we've already resolved
    exitPromise.catch(() => {});

    try {
      // initialize
      const initResult = (await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-slack-mcp", version: "1.0.0" },
      }, cfg.startupTimeoutMs)) as { capabilities?: unknown; serverInfo?: { name?: string } } | undefined;

      // initialized notification
      this.notify("notifications/initialized", {});

      // discover tools
      const listResult = (await this.request("tools/list", {})) as { tools?: MCPTool[] } | undefined;
      this.tools = (listResult?.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));

      this.connected = true;
      void initResult; // silence unused
    } catch (error) {
      // Ensure the child process tree is killed so we don't leak orphans
      // every time the handshake fails or times out.
      this.killProcessGroup(child);
      this.child = null;
      throw error;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // Pull out wrapper-only control args (NOT forwarded to the upstream server,
    // which would reject unknown params). These let the model override
    // post-processing for a single call without editing the JSON config.
    const forwarded = { ...args };
    let raw = false;
    let maxTextOverride: number | undefined;
    if ("_raw" in forwarded) {
      raw = forwarded._raw === true || forwarded._raw === "true";
      delete forwarded._raw;
    }
    if ("_maxTextLength" in forwarded) {
      const v = forwarded._maxTextLength;
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
      if (Number.isFinite(n) && n >= 0) maxTextOverride = n;
      delete forwarded._maxTextLength;
    }

    const timeoutMs = this.requestTimeoutMsByTool[name] ?? this.requestTimeoutMs;
    const result = (await this.request("tools/call", { name, arguments: forwarded }, timeoutMs)) as
      | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      | undefined;

    if (!result) return "";
    const content = result.content;
    let text: string;
    if (Array.isArray(content)) {
      text = content.map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c))).join("\n");
    } else {
      text = JSON.stringify(result);
    }
    if (raw || !this.postProcess.enabled) return text;
    const pp =
      maxTextOverride === undefined
        ? this.postProcess
        : { ...this.postProcess, maxTextLength: maxTextOverride };
    return postProcessCsv(text, pp, this.authEnv);
  }

  async disconnect(): Promise<void> {
    if (!this.child) {
      this.connected = false;
      return;
    }
    const child = this.child;
    const childPid = child.pid;
    this.connected = false;
    this.tools = [];
    this.child = null;

    // Resolves when the immediate child (npm exec) exits. NOTE: this does
    // NOT guarantee grandchildren are dead — npm exec can exit on stdin
    // EOF leaving its node+Go descendants behind. That's why we ALWAYS run
    // killProcessTreeHard below, regardless of whether `exited` resolves.
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
    });

    // Stage 1: nudge the server to flush and exit cleanly.
    try { child.stdin.end(); } catch { /* ignore */ }
    // Stage 1.5: SIGTERM the entire process group immediately. Negative pid
    // targets the group leader's group, which works because we spawned with
    // detached:true so npm + node + Go all share PGID = child.pid.
    if (childPid !== undefined) {
      try { process.kill(-childPid, "SIGTERM"); } catch { /* already exited */ }
    }

    // Stage 2: hard SIGKILL after a short delay. We do this UNCONDITIONALLY
    // (not in a clearable timer that gets cancelled when `exited` resolves)
    // because npm exec exiting first leaves grandchildren orphaned. Without
    // an unconditional SIGKILL we leak entire process trees on every
    // disconnect.
    const sigkillTimer = setTimeout(() => {
      if (childPid !== undefined) killProcessTreeHard(childPid);
    }, DISCONNECT_SIGKILL_DELAY_MS);
    // Don't keep the event loop alive solely for this timer — we want pi to
    // be free to exit. The at-exit hook is the final safety net.
    sigkillTimer.unref?.();

    // Bound the wait: never block disconnect forever waiting for `exit`.
    const hardTimeoutTimer = setTimeout(() => { /* let the await give up */ }, DISCONNECT_HARD_TIMEOUT_MS);
    hardTimeoutTimer.unref?.();
    const hardTimeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), DISCONNECT_HARD_TIMEOUT_MS).unref?.();
    });

    try {
      const winner = await Promise.race([exited.then(() => "exited" as const), hardTimeout]);
      if (winner === "timeout" && childPid !== undefined) {
        // Force-kill on hard timeout and continue.
        killProcessTreeHard(childPid);
      }
    } finally {
      clearTimeout(sigkillTimer);
      clearTimeout(hardTimeoutTimer);
      // Belt-and-suspenders final reap. Idempotent: signals to already-dead
      // pids just throw ESRCH which we swallow.
      if (childPid !== undefined) {
        killProcessTreeHard(childPid);
        trackedChildren().delete(childPid);
      }
    }

    // Reject any leftover requests
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Disconnected"));
    }
    this.pending.clear();
  }

  // ---------------------------------------------------------------------------

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    // newline-delimited JSON-RPC framing
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch (error) {
        console.warn(`[slack-mcp] Invalid JSON from server: ${line}`);
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: JsonRpcResponse): void {
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // Server-initiated notification or unmatched response — ignore for now
  }

  private write(payload: object): void {
    if (!this.child) throw new Error("Not connected to MCP server");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch (error) {
      console.warn(`[slack-mcp] Failed to send notification ${method}: ${(error as Error).message}`);
    }
  }
}
