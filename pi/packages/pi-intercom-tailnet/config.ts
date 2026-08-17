// Configuration for the tailnet relay. The file follows pi-intercom's
// PI_CODING_AGENT_DIR and defaults to ~/.pi/agent/intercom/tailnet.json.

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";

export function getAgentDirPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  cwd: string = process.cwd(),
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homeDir, ".pi/agent");
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

export function getIntercomDirPath(agentDir: string = getAgentDirPath()): string {
  return join(agentDir, "intercom");
}

export function getTailnetConfigPath(agentDir: string = getAgentDirPath()): string {
  return join(getIntercomDirPath(agentDir), "tailnet.json");
}

export function getBrokerSocketPath(agentDir: string = getAgentDirPath()): string {
  return join(getIntercomDirPath(agentDir), "broker.sock");
}

export function getRelayPidPath(agentDir: string = getAgentDirPath()): string {
  return join(getIntercomDirPath(agentDir), "tailnet-relay.pid");
}

/** @deprecated Prefer getTailnetConfigPath(), which observes runtime environment changes. */
export const TAILNET_CONFIG_PATH = getTailnetConfigPath();
export const TAILNET_DEFAULT_PORT = 4271;

export interface TailnetConfig {
  /** Master enable. Default false. Relay refuses to start without this. */
  enabled: boolean;

  /** TCP port the relay listens on (Tailscale interface only). */
  port: number;

  /**
   * Static peer allowlist for Phase 0. Each entry is a Tailscale
   * MagicDNS short name (e.g. "nimbus"). Inbound connections from
   * peers not on this list are rejected before any frame is read.
   *
   * Phase 1 will replace this with an interactive grant flow.
   */
  allowedHosts: string[];

  /**
   * If true, the relay polls `tailscale status --json` every
   * `discoveryIntervalMs` to learn about online peers. Default true.
   * Disable for tests or hermetic environments.
   */
  discovery: boolean;

  discoveryIntervalMs: number;

  /** Path to the tailscale CLI. Default looks it up on PATH. */
  tailscaleCli?: string;

  /**
   * Override the local host's MagicDNS short name. Useful for tests;
   * normally derived from `tailscale status --json`.
   */
  hostOverride?: string;
}

const defaults: TailnetConfig = {
  enabled: false,
  port: TAILNET_DEFAULT_PORT,
  allowedHosts: [],
  discovery: true,
  discoveryIntervalMs: 15_000,
};

export function loadTailnetConfig(path: string = getTailnetConfigPath()): TailnetConfig {
  if (!existsSync(path)) {
    return { ...defaults };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    console.error(`[pi-intercom-tailnet] failed to read ${path}:`, error);
    return { ...defaults };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`[pi-intercom-tailnet] failed to parse ${path}:`, error);
    return { ...defaults };
  }

  return mergeConfig(defaults, parsed);
}

export function mergeConfig(base: TailnetConfig, override: unknown): TailnetConfig {
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    return { ...base };
  }
  const cfg = { ...base };
  const o = override as Record<string, unknown>;

  if (typeof o.enabled === "boolean") cfg.enabled = o.enabled;
  if (typeof o.port === "number" && Number.isFinite(o.port) && o.port > 0 && o.port < 65536) {
    cfg.port = Math.floor(o.port);
  }
  if (Array.isArray(o.allowedHosts)) {
    cfg.allowedHosts = o.allowedHosts.filter((v): v is string => typeof v === "string");
  }
  if (typeof o.discovery === "boolean") cfg.discovery = o.discovery;
  if (typeof o.discoveryIntervalMs === "number" && o.discoveryIntervalMs >= 1000) {
    cfg.discoveryIntervalMs = Math.floor(o.discoveryIntervalMs);
  }
  if (typeof o.tailscaleCli === "string" && o.tailscaleCli.trim()) {
    cfg.tailscaleCli = o.tailscaleCli.trim();
  }
  if (typeof o.hostOverride === "string" && o.hostOverride.trim()) {
    cfg.hostOverride = o.hostOverride.trim();
  }

  return cfg;
}

/** Lower-case host string for deterministic comparisons. */
export function normaliseHost(host: string): string {
  return host.trim().toLowerCase();
}

/** True if the peer is on the static allowlist (case-insensitive). */
export function isPeerAllowed(cfg: TailnetConfig, peerHost: string): boolean {
  const target = normaliseHost(peerHost);
  if (!target) return false;
  return cfg.allowedHosts.some((h) => normaliseHost(h) === target);
}
