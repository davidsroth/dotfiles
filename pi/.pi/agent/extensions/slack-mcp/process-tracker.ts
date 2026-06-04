// =============================================================================
// Child-process tracker + last-resort cleanup
// =============================================================================
//
// Why a module-level tracker, separate from the SharedEntry registry:
//
// 1. The orphan-leak we're guarding against happens when the pi process is
//    torn down BEFORE our async `disconnect()` finishes (e.g. during reload
//    or unexpected exit). At that point, `releaseClient` may have started
//    but the SIGTERM/SIGKILL timers haven't fired yet — the Node event loop
//    just stops.
// 2. `process.on("exit", ...)` handlers run synchronously at the very end
//    and can still call `process.kill(...)`. We use this as a last resort
//    to reap any still-tracked child PIDs.
// 3. Tracker is pinned to globalThis so jiti reimports of this file share
//    the same set, consistent with the SharedEntry registry.

import { execSync } from "node:child_process";

const TRACKED_CHILDREN_KEY = "__piSlackMCPTrackedChildren_v1__";
const EXIT_HOOK_KEY = "__piSlackMCPExitHookInstalled_v1__";

export function trackedChildren(): Set<number> {
  const g = globalThis as Record<string, unknown>;
  let s = g[TRACKED_CHILDREN_KEY] as Set<number> | undefined;
  if (!s) {
    s = new Set();
    g[TRACKED_CHILDREN_KEY] = s;
  }
  return s;
}

export function installExitHookOnce(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[EXIT_HOOK_KEY]) return;
  g[EXIT_HOOK_KEY] = true;
  // Synchronous-only: must not await. process.kill is sync.
  const reapAll = () => {
    const children = trackedChildren();
    for (const pid of children) {
      // Kill the whole process group first (we spawned with detached:true,
      // so npm + node + Go all share PGID=pid).
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      // Belt-and-suspenders: also signal the leader directly.
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    children.clear();
  };
  process.on("exit", reapAll);
  // Don't register SIGINT/SIGTERM handlers — pi installs its own and we
  // don't want to interfere. The 'exit' hook fires after pi's signal
  // handlers complete (or after natural process termination), which is the
  // correct point for last-resort cleanup.
}

/**
 * Collect descendant PIDs (any depth) of a given root PID via `ps`.
 * Used by killProcessTree as a fallback in case some grandchild has
 * escaped the parent's process group (e.g. via setsid). Best-effort:
 * returns [] on any ps error.
 */
function collectDescendants(rootPid: number): number[] {
  try {
    const out = execSync("ps -A -o pid=,ppid=", { encoding: "utf-8", timeout: 1000 });
    const children = new Map<number, number[]>();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push(pid);
    }
    const result: number[] = [];
    const stack = [rootPid];
    while (stack.length) {
      const p = stack.pop()!;
      const kids = children.get(p);
      if (!kids) continue;
      for (const k of kids) {
        result.push(k);
        stack.push(k);
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Kill a process group hard and fast. Used both on connect-failure cleanup
 * and as the final stage of disconnect. Idempotent.
 *
 * Strategy:
 *   1. SIGKILL the process group (npm + node + Go binary, since we spawned
 *      with detached:true so they share PGID).
 *   2. SIGKILL the leader pid directly (in case the leader has moved to a
 *      different PGID — rare but possible).
 *   3. Walk descendants via `ps` and SIGKILL each — catches any grandchild
 *      that called setsid() or otherwise escaped the original PGID.
 */
export function killProcessTreeHard(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  for (const descendant of collectDescendants(pid)) {
    try { process.kill(descendant, "SIGKILL"); } catch { /* gone */ }
  }
}
