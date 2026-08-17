import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTsxCliPath } from "./spawn.ts";

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function waitForOutput(child: ChildProcessWithoutNullStreams, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for broker output: ${output}`)), 5000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(text)) {
        clearTimeout(timeout);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Broker exited before startup (${code ?? signal}): ${output}`));
    });
  });
}

function startBroker(agentDir: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [getTsxCliPath(repoDir), path.join(repoDir, "broker", "broker.ts")], {
    cwd: repoDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

test("broker probe does not unlink an active Unix socket", { skip: process.platform === "win32" }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-live-socket-"));
  const intercomDir = path.join(agentDir, "intercom");
  const socketPath = path.join(intercomDir, "broker.sock");
  const owner = net.createServer(socket => socket.end());
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    mkdirSync(intercomDir, { recursive: true });
    await listen(owner, socketPath);
    const identity = statSync(socketPath);

    child = startBroker(agentDir);
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(signal, null);
    assert.equal(code, 0);
    const current = statSync(socketPath);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise<void>(resolve => owner.close(() => resolve()));
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("broker shutdown preserves replacement socket and PID claims", { skip: process.platform === "win32" }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-owned-runtime-"));
  const intercomDir = path.join(agentDir, "intercom");
  const socketPath = path.join(intercomDir, "broker.sock");
  const pidPath = path.join(intercomDir, "broker.pid");
  const replacement = net.createServer(socket => socket.end());
  const broker = startBroker(agentDir);
  try {
    await waitForOutput(broker, "Intercom broker started");
    renameSync(socketPath, `${socketPath}.old`);
    await listen(replacement, socketPath);
    const replacementIdentity = statSync(socketPath);
    writeFileSync(pidPath, "replacement\n");

    broker.kill("SIGTERM");
    await once(broker, "exit");

    const current = statSync(socketPath);
    assert.equal(current.dev, replacementIdentity.dev);
    assert.equal(current.ino, replacementIdentity.ino);
    assert.equal(readFileSync(pidPath, "utf8"), "replacement\n");
  } finally {
    if (broker.exitCode === null && broker.signalCode === null) {
      broker.kill("SIGKILL");
      await once(broker, "exit").catch(() => undefined);
    }
    await new Promise<void>(resolve => replacement.close(() => resolve()));
    rmSync(agentDir, { recursive: true, force: true });
  }
});
