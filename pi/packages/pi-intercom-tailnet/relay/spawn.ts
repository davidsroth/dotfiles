// Auto-spawn the tailnet relay if config has it enabled.
//
// The relay atomically claims its PID file before registering, while this
// launcher performs the cheap already-running check to avoid needless spawns.

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";
import { getRelayPidPath } from "../config.js";

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

const RELAY_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "USERNAME", "USERPROFILE", "LOGNAME", "SHELL",
  "TMPDIR", "TMP", "TEMP", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "SystemRoot", "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA",
  "XDG_RUNTIME_DIR", "NVM_DIR", "NVM_BIN", "NVM_INC", "NODE_PATH",
]);

/** Build the relay environment without inheriting unrelated API keys/tokens. */
export function buildRelayEnv(
  source: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (RELAY_ENV_KEYS.has(key) || key.startsWith("PI_INTERCOM_")) env[key] = value;
  }
  const configuredAgentDir = source.PI_CODING_AGENT_DIR?.trim();
  if (configuredAgentDir) {
    env.PI_CODING_AGENT_DIR = isAbsolute(configuredAgentDir)
      ? configuredAgentDir
      : resolve(cwd, configuredAgentDir);
  }
  return env;
}

export function isRelayRunning(pidPath: string = getRelayPidPath()): boolean {
  if (!existsSync(pidPath)) return false;
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
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
    env: buildRelayEnv(),
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
