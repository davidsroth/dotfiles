// =============================================================================
// Slack credential resolution and secret-safe fingerprints
// =============================================================================

import { createHash } from "node:crypto";

export const SLACK_AUTH_ENV_KEYS = [
  "SLACK_MCP_XOXP_TOKEN",
  "SLACK_MCP_XOXB_TOKEN",
  "SLACK_MCP_XOXC_TOKEN",
  "SLACK_MCP_XOXD_TOKEN",
] as const;

type SlackAuthEnvKey = (typeof SLACK_AUTH_ENV_KEYS)[number];
type Env = Record<string, string | undefined>;

export interface SlackCredentials {
  mode: "xoxp" | "xoxb" | "browser";
  token: string;
  cookie?: string;
}

function hasOwnCredentialKey(env: Env): boolean {
  return SLACK_AUTH_ENV_KEYS.some((key) => Object.prototype.hasOwnProperty.call(env, key));
}

/**
 * Select exactly one credential mode from one environment. A partial browser
 * credential is invalid and is never completed from another source.
 */
export function resolveSlackCredentials(env: Env): SlackCredentials | null {
  const xoxp = env.SLACK_MCP_XOXP_TOKEN;
  if (xoxp) return { mode: "xoxp", token: xoxp };

  const xoxb = env.SLACK_MCP_XOXB_TOKEN;
  if (xoxb) return { mode: "xoxb", token: xoxb };

  const xoxc = env.SLACK_MCP_XOXC_TOKEN;
  const xoxd = env.SLACK_MCP_XOXD_TOKEN;
  if (xoxc && xoxd) return { mode: "browser", token: xoxc, cookie: `d=${xoxd}` };

  return null;
}

function credentialEnv(credentials: SlackCredentials | null): Record<string, string> {
  if (!credentials) return {};
  switch (credentials.mode) {
    case "xoxp":
      return { SLACK_MCP_XOXP_TOKEN: credentials.token };
    case "xoxb":
      return { SLACK_MCP_XOXB_TOKEN: credentials.token };
    case "browser":
      return {
        SLACK_MCP_XOXC_TOKEN: credentials.token,
        SLACK_MCP_XOXD_TOKEN: credentials.cookie!.slice(2),
      };
  }
}

/**
 * Build the single effective environment used by config, child spawning,
 * identity lookup, and registry keying. If the auth file mentions any Slack
 * credential key, that source is authoritative: inherited credentials are
 * ignored, including when the explicit browser pair is incomplete.
 */
export function resolveEffectiveSlackEnv(
  configuredEnv: Record<string, string> = {},
  inheritedEnv: Env = process.env,
): Record<string, string> {
  const effective: Record<string, string> = {};
  for (const [key, value] of Object.entries(configuredEnv)) {
    if (!(SLACK_AUTH_ENV_KEYS as readonly string[]).includes(key)) effective[key] = value;
  }

  const source = hasOwnCredentialKey(configuredEnv) ? configuredEnv : inheritedEnv;
  return { ...effective, ...credentialEnv(resolveSlackCredentials(source)) };
}

export function isSlackAuthEnvKey(key: string): key is SlackAuthEnvKey {
  return (SLACK_AUTH_ENV_KEYS as readonly string[]).includes(key);
}

/** SHA-256 fingerprint suitable for cache/registry keys that must not leak input. */
export function sha256Fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function credentialFingerprint(credentials: SlackCredentials): string {
  return sha256Fingerprint(JSON.stringify({
    mode: credentials.mode,
    token: credentials.token,
    cookie: credentials.cookie ?? null,
  }));
}
