// Auto-spawn the tailnet relay if config has it enabled.
//
// We deliberately keep this very thin: spawn once per pi extension
// activation, write the pid file from the relay process itself, and
// just check the pid file to avoid double-spawning. No locking dance
// like pi-intercom does for its broker — the relay is opt-in and the
// race window is tiny.

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const INTERCOM_DIR = join(homedir(), ".pi/agent/intercom");
const RELAY_PID_PATH = join(INTERCOM_DIR, "tailnet-relay.pid");
const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_SCRIPT = join(EXTENSION_DIR, "relay", "relay.ts");

function pidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // signal 0 = existence probe
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means a process with that pid exists but isn't ours
    return code === "EPERM";
  }
}

export function isRelayRunning(): boolean {
  if (!existsSync(RELAY_PID_PATH)) return false;
  try {
    const pid = Number.parseInt(readFileSync(RELAY_PID_PATH, "utf-8").trim(), 10);
    return pidRunning(pid);
  } catch {
    return false;
  }
}

export function spawnRelayIfNeeded(): void {
  if (isRelayRunning()) return;
  if (!existsSync(RELAY_SCRIPT)) {
    console.error(`[pi-intercom-tailnet] relay script missing: ${RELAY_SCRIPT}`);
    return;
  }
  const tsxBin = join(EXTENSION_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const command = existsSync(tsxBin) ? process.execPath : "npx";
  const args = existsSync(tsxBin)
    ? [tsxBin, RELAY_SCRIPT]
    : ["--no-install", "tsx", RELAY_SCRIPT];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  // Watchdog: if the relay exits unexpectedly, respawn it after a short
  // backoff. This keeps the broker alive (relay is a registered session)
  // across pi session reloads and network interruptions.
  child.once("exit", (code, signal) => {
    // Clean intentional shutdown (SIGTERM/SIGINT from shutdown()) — don't respawn.
    if (signal === "SIGTERM" || signal === "SIGINT" || code === 0) return;
    setTimeout(() => spawnRelayIfNeeded(), 3000);
  });

  child.unref();
}
