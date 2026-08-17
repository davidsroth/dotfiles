// @ts-nocheck
/** Integration test for the patched managed integration; never touches ~/.pi. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixture = path.join(repo, "core/.config/herdr/patches/herdr-agent-state-v8.ts");
const patcher = path.join(repo, "core/.config/herdr/bin/apply-herdr-pi-state-patch.py");
const registryKey = Symbol.for("pi-subagents:activity-registry");

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakePi {
  lifecycle = new Map<string, Function[]>();
  events = {
    listeners: new Map<string, Function[]>(),
    on: (event: string, handler: Function) => {
      const handlers = this.events.listeners.get(event) ?? [];
      handlers.push(handler);
      this.events.listeners.set(event, handlers);
      return () => this.events.listeners.set(event, handlers.filter((candidate) => candidate !== handler));
    },
    emit: (event: string, data?: unknown) => {
      for (const handler of this.events.listeners.get(event) ?? []) handler(data);
    },
  };
  on(event: string, handler: Function) {
    const handlers = this.lifecycle.get(event) ?? [];
    handlers.push(handler);
    this.lifecycle.set(event, handlers);
  }
  async emitLifecycle(event: string, payload: unknown, ctx: unknown) {
    for (const handler of this.lifecycle.get(event) ?? []) await handler(payload, ctx);
  }
}

test("patched Herdr Pi integration preserves its authority while aggregating root activity", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "herdr-pi-state-test-"));
  const target = path.join(tmp, "herdr-agent-state.ts");
  const socketPath = path.join(tmp, "herdr.sock");
  const previousEnv = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  };
  const priorRegistry = globalThis[registryKey];
  const requests: any[] = [];
  let snapshot = [{ id: "reload-agent", type: "Explore", description: "Already running", status: "running" }];
  const server = net.createServer((socket) => {
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
      if (!body.includes("\n")) return;
      requests.push(JSON.parse(body.trim()));
      socket.end("ok\n");
    });
  });

  try {
    copyFileSync(fixture, target);
    execFileSync("python3", [patcher, "--target", target], { stdio: "pipe" });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });

    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = socketPath;
    process.env.HERDR_PANE_ID = "pane-1";
    globalThis[registryKey] = {
      registry: { getActiveSubagents: (sessionId: string) => sessionId === "root-session" ? snapshot : [] },
    };

    const integration = await import(`${pathToFileURL(target).href}?test=${Date.now()}`);
    const pi = new FakePi();
    integration.default(pi);
    const ctx = {
      mode: "tui",
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "root-session",
        getSessionFile: () => "/tmp/root-session.jsonl",
      },
    };
    await pi.emitLifecycle("session_start", { reason: "resume" }, ctx);

    await waitFor(
      () => requests.some((request) => request.method === "pane.report_agent" && request.params.state === "working"),
      "reload snapshot working state",
    );
    const sessionReport = requests.find((request) => request.method === "pane.report_agent_session");
    assert.equal(sessionReport.params.source, "herdr:pi");
    assert.equal(sessionReport.params.agent_session_path, "/tmp/root-session.jsonl");
    const firstWorking = requests.find((request) => request.method === "pane.report_agent" && request.params.state === "working");
    assert.equal(firstWorking.params.agent_session_path, "/tmp/root-session.jsonl");
    assert.equal(firstWorking.params.source, "herdr:pi");

    // Only the current root session may reconcile a subagent-ready snapshot.
    pi.events.emit("subagents:ready", { sessionId: "root-session", activeSubagents: [] });
    await waitFor(
      () => requests.some((request) => request.method === "pane.report_agent" && request.params.state === "idle"),
      "idle after matching ready snapshot",
    );
    const reportsBeforeMismatchedReady = requests.filter((request) => request.method === "pane.report_agent").length;
    pi.events.emit("subagents:ready", {
      sessionId: "other-root-session",
      activeSubagents: [{ id: "wrong-session-agent", type: "Plan", description: "Must stay hidden", status: "running" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      requests.filter((request) => request.method === "pane.report_agent").length,
      reportsBeforeMismatchedReady,
      "a mismatched ready snapshot must not be reconciled",
    );
    pi.events.emit("subagents:created", {
      id: "wrong-session-agent",
      sessionId: "other-root-session",
      type: "Plan",
      description: "Must stay hidden",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      requests.filter((request) => request.method === "pane.report_agent").length,
      reportsBeforeMismatchedReady,
      "a mismatched lifecycle event must not reattribute activity",
    );
    pi.events.emit("subagents:ready", {
      sessionId: "root-session",
      activeSubagents: [{ id: "ready-agent", type: "Plan", description: "Current root activity", status: "running" }],
    });
    await waitFor(
      () => requests.filter((request) => request.method === "pane.report_agent" && request.params.state === "working").length >= 2,
      "working after matching ready snapshot",
    );
    pi.events.emit("subagents:failed", { id: "ready-agent", sessionId: "root-session" });
    await waitFor(
      () => requests.filter((request) => request.method === "pane.report_agent" && request.params.state === "idle").length >= 2,
      "idle after matching ready activity completes",
    );

    // A terminal event clears a snapshot restored during an integration reload.
    pi.events.emit("subagents:failed", { id: "reload-agent", sessionId: "root-session" });
    await waitFor(
      () => requests.some((request) => request.method === "pane.report_agent" && request.params.state === "idle"),
      "idle after restored subagent completes",
    );

    pi.events.emit("subagents:created", { id: "child-a", sessionId: "root-session", type: "Plan", description: "Review plan" });
    await waitFor(
      () => requests.filter((request) => request.method === "pane.report_agent" && request.params.state === "working").length >= 2,
      "working after child is created",
    );
    pi.events.emit("subagents:started", { id: "child-a", sessionId: "root-session", type: "Plan", description: "Review plan" });

    pi.events.emit("herdr:blocked", { id: "block-a", active: true, label: "First decision" });
    await waitFor(
      () => requests.some((request) => request.method === "pane.report_agent" && request.params.state === "blocked" && request.params.message === "First decision"),
      "first blocker",
    );
    pi.events.emit("herdr:blocked", { id: "block-b", active: true, label: "Second decision" });
    await waitFor(
      () => requests.some((request) => request.method === "pane.report_agent" && request.params.state === "blocked" && request.params.message === "Second decision"),
      "second blocker",
    );
    // Closing the older blocker must not clear the newer external wait.
    pi.events.emit("herdr:blocked", { id: "block-a", active: false, label: "First decision" });
    pi.events.emit("herdr:blocked", { id: "block-b", active: false, label: "Second decision" });
    await waitFor(
      () => requests.filter((request) => request.method === "pane.report_agent" && request.params.state === "working").length >= 3,
      "working after out-of-order blockers close",
    );

    // Legacy qna-style events remain supported without closing identified waits.
    pi.events.emit("herdr:blocked", { active: true, label: "Legacy wait" });
    await waitFor(
      () => requests.some((request) => request.method === "pane.report_agent" && request.params.message === "Legacy wait"),
      "legacy blocker",
    );
    pi.events.emit("herdr:blocked", { id: "identified", active: true, label: "Identified wait" });
    await waitFor(
      () => requests.some((request) => request.method === "pane.report_agent" && request.params.message === "Identified wait"),
      "identified blocker",
    );
    pi.events.emit("herdr:blocked", { active: false, label: "Legacy wait" });
    pi.events.emit("herdr:blocked", { id: "identified", active: false, label: "Identified wait" });
    await waitFor(
      () => requests.filter((request) => request.method === "pane.report_agent" && request.params.state === "working").length >= 4,
      "working after legacy and identified waits close",
    );
    pi.events.emit("subagents:failed", { id: "child-a", sessionId: "root-session" });
    await waitFor(
      () => requests.filter((request) => request.method === "pane.report_agent" && request.params.state === "idle").length >= 2,
      "idle after active child completes",
    );

    // A stopped lifecycle event removes activity immediately; duplicate settlement is inert.
    pi.events.emit("subagents:created", { id: "stopped-agent", sessionId: "root-session", type: "Explore", description: "Stop me" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    pi.events.emit("subagents:failed", { id: "stopped-agent", sessionId: "root-session", status: "stopped" });
    await waitFor(
      () => requests.filter((request) => request.method === "pane.report_agent" && request.params.state === "idle").length >= 3,
      "idle after stopped subagent",
    );
    const stateCountAfterStop = requests.filter((request) => request.method === "pane.report_agent").length;
    pi.events.emit("subagents:failed", { id: "stopped-agent", sessionId: "root-session", status: "stopped" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests.filter((request) => request.method === "pane.report_agent").length, stateCountAfterStop);

    const sequences = requests.map((request) => request.params.seq).filter((seq) => typeof seq === "number");
    assert.ok(sequences.every((seq, index) => index === 0 || seq > sequences[index - 1]), "reports retain one increasing sequence");
    assert.ok(requests.filter((request) => request.method === "pane.report_agent").every((request) => (
      request.params.source === "herdr:pi" && request.params.agent_session_path === "/tmp/root-session.jsonl"
    )), "all state reports retain the managed session reference and source");
  } finally {
    server.close();
    globalThis[registryKey] = priorRegistry;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
