import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionInfo } from "../types.ts";

export const ACTIVE_STATUS_FRESH_MS = 30 * 60 * 1000;
export const DEFAULT_AGENT_PICKER_KEY = "ctrl+alt+a";

export type ActivityState = "active" | "idle" | "stale";

export function resolveAgentPickerKey(value = process.env.PI_INTERCOM_AGENT_PICKER_KEY): string {
  return value?.trim() || DEFAULT_AGENT_PICKER_KEY;
}

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

export function sortSessionsForPicker(sessions: SessionInfo[], now = Date.now()): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    const rankDelta = sessionActivityRank(a, now) - sessionActivityRank(b, now);
    if (rankDelta !== 0) return rankDelta;
    const activityDelta = b.lastActivity - a.lastActivity;
    if (activityDelta !== 0) return activityDelta;
    return a.id.localeCompare(b.id);
  });
}

export function formatAge(timestamp: number, now = Date.now()): string {
  const elapsedMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export function cwdLabel(cwd: string): string {
  const trimmed = cwd.replace(/\/$/, "");
  return trimmed.split("/").filter(Boolean).pop() || cwd || "?";
}

export function middleTruncate(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return truncateToWidth(text, maxWidth, "");

  const chars = [...text];
  const side = Math.max(1, Math.floor((maxWidth - 1) / 2));
  let left = "";
  for (const char of chars) {
    if (visibleWidth(left + char) > side) break;
    left += char;
  }
  let right = "";
  for (const char of chars.slice().reverse()) {
    if (visibleWidth(char + right) > side) break;
    right = char + right;
  }
  return truncateToWidth(`${left}…${right}`, maxWidth, "");
}
