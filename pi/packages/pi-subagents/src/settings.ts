// Persistence for pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (via getAgentDir()) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agent-manage → Settings; overrides global on load

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JoinMode } from "./types.js";

export interface SubagentsSettings {
  maxConcurrent?: number;
  defaultJoinMode?: JoinMode;
  /**
   * Master switch for the schedule subagent feature. Defaults to `true`.
   * When `false`: the `Agent` tool's `schedule` param + its guideline are
   * stripped from the tool spec at registration (zero LLM-context cost), the
   * scheduler doesn't bind to the session, and the `/agent-manage → Scheduled jobs`
   * menu entry is hidden. Schema-level removal applies at extension load
   * (next pi session); runtime menu/runtime-fire short-circuit is immediate.
   */
  schedulingEnabled?: boolean;
}

/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setSchedulingEnabled: (b: boolean) => void;
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const VALID_JOIN_MODES: ReadonlySet<string> = new Set<JoinMode>(["async", "group", "smart"]);

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  if (
    Number.isInteger(r.maxConcurrent) &&
    (r.maxConcurrent as number) >= 1 &&
    (r.maxConcurrent as number) <= MAX_CONCURRENT_CEILING
  ) {
    out.maxConcurrent = r.maxConcurrent as number;
  }
  if (typeof r.defaultJoinMode === "string" && VALID_JOIN_MODES.has(r.defaultJoinMode)) {
    out.defaultJoinMode = r.defaultJoinMode as JoinMode;
  }
  if (typeof r.schedulingEnabled === "boolean") {
    out.schedulingEnabled = r.schedulingEnabled;
  }
  return out;
}

function globalPath(): string {
  return join(getAgentDir(), "subagents.json");
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 */
function readSettingsFile(path: string): SubagentsSettings {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}

/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  if (typeof s.maxConcurrent === "number") appliers.setMaxConcurrent(s.maxConcurrent);
  if (s.defaultJoinMode) appliers.setDefaultJoinMode(s.defaultJoinMode);
  if (typeof s.schedulingEnabled === "boolean") appliers.setSchedulingEnabled(s.schedulingEnabled);
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export function applyAndEmitLoaded(
  appliers: SettingsAppliers,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, appliers);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * flag so listeners can react to write failures.
 */
export function saveAndEmitChanged(
  snapshot: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const persisted = saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted });
  return persistToastFor(successMsg, persisted);
}
