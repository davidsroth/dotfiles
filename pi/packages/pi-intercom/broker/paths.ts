import { join } from "path";
import { homedir } from "os";

function sanitizePipeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "default";
}

export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(homeDir)}`;
  }

  return join(homeDir, ".pi/agent/intercom/broker.sock");
}

export function classifySocketProbeError(error: Pick<NodeJS.ErrnoException, "code">): "stale" | "indeterminate" {
  // A missing path or refused connection is the normal stale Unix-socket case.
  // Resource exhaustion, permissions, and other local failures do not prove the
  // existing socket is dead, so never unlink it on those errors.
  return error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "stale" : "indeterminate";
}

export function getBrokerLogPath(homeDir: string = homedir()): string {
  return join(homeDir, ".pi/agent/intercom/broker.log");
}

export function getBrokerPidPath(homeDir: string = homedir()): string {
  return join(homeDir, ".pi/agent/intercom/broker.pid");
}
