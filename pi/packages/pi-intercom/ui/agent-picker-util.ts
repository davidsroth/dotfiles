import type { SessionInfo } from "../types.js";

/**
 * Pure helpers shared by the agent picker overlay (`ui/agent-picker.ts`) and
 * the extension entrypoint (`index.ts`). Kept free of `pi-tui`/runtime deps so
 * they can be unit tested in isolation (see `test/agent-picker.test.ts`).
 */

export const ACTIVE_STATUS_FRESH_MS = 30 * 60 * 1000;

export type ActivityState = "active" | "idle" | "stale";

function isBusyStatus(status?: string): boolean {
  return Boolean(status && !status.includes("idle"));
}

export function activityState(session: SessionInfo, now = Date.now()): ActivityState {
  if (!isBusyStatus(session.status)) return "idle";
  return now - session.lastActivity <= ACTIVE_STATUS_FRESH_MS ? "active" : "stale";
}

const ACTIVITY_RANK: Record<ActivityState, number> = { active: 0, idle: 1, stale: 2 };

export function sessionActivityRank(session: SessionInfo, now = Date.now()): number {
  return ACTIVITY_RANK[activityState(session, now)];
}

export function sortSessionsForPicker(sessions: SessionInfo[]): SessionInfo[] {
  const now = Date.now();
  return [...sessions].sort((a, b) => {
    const rankDelta = sessionActivityRank(a, now) - sessionActivityRank(b, now);
    if (rankDelta !== 0) return rankDelta;
    return b.lastActivity - a.lastActivity;
  });
}

export function parseTmuxTarget(target: string): { session: string; window: string } | null {
  const colon = target.lastIndexOf(":");
  if (colon <= 0) return null;
  const session = target.slice(0, colon);
  const windowPane = target.slice(colon + 1);
  const dot = windowPane.indexOf(".");
  if (!session || dot <= 0) return null;
  return { session, window: windowPane.slice(0, dot) };
}

export function formatAge(timestamp: number, now = Date.now()): string {
  const elapsedMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
