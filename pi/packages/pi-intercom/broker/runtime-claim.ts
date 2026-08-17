import { existsSync, readFileSync, statSync } from "node:fs";

export interface RuntimeFileIdentity {
  dev: number;
  ino: number;
}

export function captureRuntimeFileIdentity(filePath: string): RuntimeFileIdentity | null {
  try {
    const stat = statSync(filePath);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

export function runtimeFileHasIdentity(filePath: string, identity: RuntimeFileIdentity | null): boolean {
  if (!identity) return false;
  const current = captureRuntimeFileIdentity(filePath);
  return current?.dev === identity.dev && current.ino === identity.ino;
}

export function pidFileIsOwnedBy(pidPath: string, pid: number): boolean {
  try {
    return readFileSync(pidPath, "utf8").trim() === String(pid);
  } catch {
    return false;
  }
}

export function tcpEndpointFileIsOwnedBy(endpointPath: string, stateId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(endpointPath, "utf8"));
    return typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).transport === "tcp"
      && (parsed as Record<string, unknown>).stateId === stateId;
  } catch {
    return false;
  }
}

export function assertNoLiveBroker(pidPath: string): void {
  if (!existsSync(pidPath)) return;

  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;

  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  throw new Error(`Refusing to replace live intercom broker process ${pid}`);
}
