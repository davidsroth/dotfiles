import { spawn } from "child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import net from "net";
import { randomUUID } from "crypto";
import { createMessageReader, writeMessage } from "./framing.ts";
import {
  ensureIntercomRuntimeDir,
  getAgentDirPath,
  getBrokerConnectTarget,
  getBrokerLogPath,
  getIntercomDirPath,
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
  type BrokerConnectTarget,
} from "./paths.ts";

const INTERCOM_DIR = getIntercomDirPath();
const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_PID = join(INTERCOM_DIR, "broker.pid");
const BROKER_SPAWN_LOCK = join(INTERCOM_DIR, "broker.spawn.lock");
export const BROKER_LOG_MAX_BYTES = 5 * 1024 * 1024;

export function openBrokerLogFd(
  logPath: string = getBrokerLogPath(INTERCOM_DIR),
  maxBytes: number = BROKER_LOG_MAX_BYTES,
): number | undefined {
  try {
    let flags = "a";
    try {
      if (statSync(logPath).size > maxBytes) {
        flags = "w";
      }
    } catch {
      // Append-create below handles an absent log.
    }
    const fd = openSync(logPath, flags, INTERCOM_RUNTIME_FILE_MODE);
    restrictIntercomRuntimeFile(logPath);
    return fd;
  } catch {
    return undefined;
  }
}

type BrokerLaunchSpec =
  | {
    kind: "direct";
    command: string;
    args: string[];
  }
  | {
    kind: "windows-launcher";
    command: string;
    args: string[];
    launcherPath: string;
    launcherCommandLine: string;
  };

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getTsxCliPath(extensionDir: string = EXTENSION_DIR): string {
  // Resolve tsx via Node's module resolution so it works regardless of whether
  // tsx is bundled under extensionDir/node_modules or hoisted to a workspace
  // root by npm. We resolve the tsx package main entry (its "exports" field
  // does not expose ./dist/cli.mjs as a subpath) and then locate cli.mjs next
  // to it. If resolution fails, prefer the flat plugin-store layout before the
  // legacy nested fallback.
  try {
    const requireFromExtension = createRequire(join(extensionDir, "package.json"));
    const tsxMain = requireFromExtension.resolve("tsx");
    return join(dirname(tsxMain), "cli.mjs");
  } catch {
    const siblingTsxCli = join(extensionDir, "..", "tsx", "dist", "cli.mjs");
    if (existsSync(siblingTsxCli)) {
      return siblingTsxCli;
    }
    return join(extensionDir, "node_modules", "tsx", "dist", "cli.mjs");
  }
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function getWindowsHiddenLauncherPath(intercomDir: string = INTERCOM_DIR): string {
  return join(intercomDir, "broker-launch.vbs");
}

function usesDefaultBrokerCommand(brokerCommand: string, brokerArgs: string[]): boolean {
  return brokerCommand === "npx"
    && brokerArgs.length === 2
    && brokerArgs[0] === "--no-install"
    && brokerArgs[1] === "tsx";
}

function getNodeCommand(nodePath: string): string {
  const executableName = nodePath.split(/[\\/]/).pop();
  return executableName && /^node(?:js)?(?:\.exe)?$/i.test(executableName)
    ? nodePath
    : "node";
}

export function getWindowsBrokerCommandLine(
  brokerPath: string,
  extensionDir: string = EXTENSION_DIR,
  nodePath: string = process.execPath,
  brokerCommand = "npx",
  brokerArgs: string[] = ["--no-install", "tsx"],
): string {
  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    return [quoteWindowsArg(getNodeCommand(nodePath)), quoteWindowsArg(getTsxCliPath(extensionDir)), quoteWindowsArg(brokerPath)].join(" ");
  }

  return [quoteWindowsArg(brokerCommand), ...brokerArgs.map(quoteWindowsArg), quoteWindowsArg(brokerPath)].join(" ");
}

export function getWindowsHiddenLauncherScript(commandLine: string): string {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${commandLine.replace(/"/g, '""')}", 0, False`,
    'Set WshShell = Nothing',
    '',
  ].join("\r\n");
}

export function isBrokerHealthOkMessage(message: unknown, requestId: string): boolean {
  if (typeof message !== "object" || message === null || !("type" in message)) {
    return false;
  }
  const response = message as Record<string, unknown>;
  return response.type === "health_ok"
    && response.requestId === requestId
    && response.protocol === INTERCOM_PROTOCOL_NAME
    && response.version === INTERCOM_PROTOCOL_VERSION;
}

function writeWindowsHiddenLauncher(
  commandLine: string,
  launcherPath: string = getWindowsHiddenLauncherPath(),
): string {
  ensureIntercomRuntimeDir(dirname(launcherPath));
  writeFileSync(launcherPath, getWindowsHiddenLauncherScript(commandLine), {
    encoding: "utf-8",
    mode: INTERCOM_RUNTIME_FILE_MODE,
  });
  restrictIntercomRuntimeFile(launcherPath);
  return launcherPath;
}

export function getBrokerLaunchSpec(
  brokerPath: string,
  brokerCommand: string,
  brokerArgs: string[],
  extensionDir: string = EXTENSION_DIR,
  platform: NodeJS.Platform = process.platform,
  intercomDir: string = INTERCOM_DIR,
  nodePath: string = process.execPath,
): BrokerLaunchSpec {
  if (platform === "win32") {
    const launcherPath = getWindowsHiddenLauncherPath(intercomDir);
    return {
      kind: "windows-launcher",
      command: "wscript.exe",
      args: [launcherPath],
      launcherPath,
      launcherCommandLine: getWindowsBrokerCommandLine(brokerPath, extensionDir, nodePath, brokerCommand, brokerArgs),
    };
  }

  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    return {
      kind: "direct",
      command: getNodeCommand(nodePath),
      args: [getTsxCliPath(extensionDir), brokerPath],
    };
  }

  return {
    kind: "direct",
    command: brokerCommand,
    args: [...brokerArgs, brokerPath],
  };
}

const BROKER_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "USERNAME", "USERPROFILE", "LOGNAME", "SHELL",
  "TMPDIR", "TMP", "TEMP", "TEMPDIR", "TERM", "COLORTERM",
  "LANG", "LANGUAGE", "TZ",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "XDG_RUNTIME_DIR", "NVM_DIR", "NVM_BIN", "NVM_INC", "NODE_PATH",
]);

/** Build a minimal daemon environment without inheriting API keys or tokens. */
export function buildBrokerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const brokerEnv: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: "1" };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upperKey = key.toUpperCase();
    if (
      BROKER_ENV_KEYS.has(upperKey)
      || upperKey.startsWith("LC_")
      || upperKey.startsWith("PI_INTERCOM_")
    ) {
      brokerEnv[key] = value;
    }
  }
  brokerEnv.PI_CODING_AGENT_DIR = getAgentDirPath(source);
  return brokerEnv;
}

export function getBrokerSpawnOptions(
  extensionDir: string = EXTENSION_DIR,
  env: NodeJS.ProcessEnv = process.env,
): {
  detached: true;
  stdio: "ignore";
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  return {
    detached: true,
    stdio: "ignore",
    cwd: extensionDir,
    env: buildBrokerEnv(env),
    windowsHide: true,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function spawnBrokerIfNeeded(brokerCommand: string, brokerArgs: string[]): Promise<void> {
  ensureIntercomRuntimeDir(INTERCOM_DIR);

  if (await isBrokerRunning()) {
    return;
  }

  const ownsLock = acquireSpawnLock();
  if (!ownsLock) {
    await waitForBroker();
    return;
  }

  try {
    if (await isBrokerRunning()) {
      return;
    }

    const brokerPath = join(dirname(fileURLToPath(import.meta.url)), "broker.ts");
    const launch = getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs);
    if (launch.kind === "windows-launcher") {
      writeWindowsHiddenLauncher(launch.launcherCommandLine, launch.launcherPath);
    }
    const spawnOptions = getBrokerSpawnOptions();
    const logFd = launch.kind === "direct" ? openBrokerLogFd() : undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, {
        ...spawnOptions,
        stdio: logFd === undefined ? spawnOptions.stdio : ["ignore", logFd, logFd],
      });
    } finally {
      if (logFd !== undefined) {
        try {
          closeSync(logFd);
        } catch {
          // The detached child has its own descriptor; parent cleanup is best effort.
        }
      }
    }
    child.unref();

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`Failed to spawn intercom broker: ${error.message}`, { cause: error }));
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (code === 0 && signal === null) {
          // A direct broker can exit cleanly after losing the socket race, and
          // the Windows launcher exits after starting its hidden child.
          return;
        }
        cleanup();
        if (signal) {
          reject(new Error(`Intercom broker exited before startup with signal ${signal}`));
          return;
        }
        reject(new Error(`Intercom broker exited before startup with code ${code ?? "unknown"}`));
      };

      child.once("error", onError);
      child.once("exit", onExit);
      waitForBroker().then(() => {
        cleanup();
        resolve();
      }, (error) => {
        cleanup();
        reject(toError(error));
      });
    });
  } finally {
    releaseSpawnLock();
  }
}

async function isBrokerRunning(): Promise<boolean> {
  if (await checkSocketConnectable()) {
    return true;
  }

  if (!existsSync(BROKER_PID)) return false;

  try {
    const pid = parseInt(readFileSync(BROKER_PID, "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return checkSocketConnectable();
  } catch {
    // Missing or unreadable PID state means there is no live broker to reuse.
    return false;
  }
}

function connectToBrokerTarget(target: BrokerConnectTarget): net.Socket {
  return typeof target === "string"
    ? net.connect(target)
    : net.connect({ host: target.host, port: target.port });
}

function checkSocketConnectable(): Promise<boolean> {
  return new Promise((resolve) => {
    let target: BrokerConnectTarget;
    try {
      target = getBrokerConnectTarget();
    } catch {
      resolve(false);
      return;
    }

    const socket = connectToBrokerTarget(target);
    const requestId = randomUUID();
    const expectedStateId = typeof target === "string" ? undefined : target.stateId;
    let settled = false;
    const finish = (isConnected: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("data", reader);
      socket.destroy();
      resolve(isConnected);
    };
    const onConnect = () => {
      try {
        writeMessage(socket, {
          type: "health",
          requestId,
          ...(expectedStateId ? { stateId: expectedStateId } : {}),
        });
      } catch {
        finish(false);
      }
    };
    const onError = () => finish(false);
    const reader = createMessageReader((message) => {
      finish(isBrokerHealthOkMessage(message, requestId));
    }, () => finish(false));
    socket.on("connect", onConnect);
    socket.on("error", onError);
    socket.on("data", reader);
    const timeout = setTimeout(() => finish(false), 1000);
  });
}

function acquireSpawnLock(): boolean {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync(BROKER_SPAWN_LOCK, `${process.pid}\n${Date.now()}\n`, {
        flag: "wx",
        mode: INTERCOM_RUNTIME_FILE_MODE,
      });
      restrictIntercomRuntimeFile(BROKER_SPAWN_LOCK);
      return true;
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale()) {
        try {
          unlinkSync(BROKER_SPAWN_LOCK);
        } catch {
          // If we can't delete the stale lock, retry a few times before giving up
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function isSpawnLockStale(): boolean {
  if (!existsSync(BROKER_SPAWN_LOCK)) {
    return false;
  }

  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;

    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        // The process that created the lock is gone.
        return true;
      }
    }

    return !Number.isFinite(createdAt) || ageMs > 10_000;
  } catch {
    // Unreadable lock contents are treated as stale so a new broker can start.
    return true;
  }
}

function releaseSpawnLock(): void {
  try {
    unlinkSync(BROKER_SPAWN_LOCK);
  } catch {
    // Another cleanup path may already have removed the lock.
  }
}

async function waitForBroker(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkSocketConnectable()) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}
