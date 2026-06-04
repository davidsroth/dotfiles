// =============================================================================
// Identity (auth.test) — powers the slack_mcp_whoami tool
// =============================================================================
//
// The upstream korotovsky server exposes no whoami/auth_test tool, so search
// modifiers like `from:@me` don't resolve and silently return zero rows.
// We call Slack's auth.test directly with the configured token to surface the
// authenticated user's ID (use `from:<user_id>` in searches). Result is cached
// per token so repeated calls are free.

export interface SlackIdentity {
  ok: boolean;
  url?: string;
  team?: string;
  user?: string;
  team_id?: string;
  user_id?: string;
  error?: string;
}

const identityCache = new Map<string, SlackIdentity>();

export function resolveSlackToken(env: Record<string, string>): { token: string; cookie?: string } | null {
  const xoxp = env.SLACK_MCP_XOXP_TOKEN || process.env.SLACK_MCP_XOXP_TOKEN;
  if (xoxp) return { token: xoxp };
  const xoxb = env.SLACK_MCP_XOXB_TOKEN || process.env.SLACK_MCP_XOXB_TOKEN;
  if (xoxb) return { token: xoxb };
  // Browser (stealth) tokens: xoxc is the Bearer, xoxd is the `d` cookie.
  const xoxc = env.SLACK_MCP_XOXC_TOKEN || process.env.SLACK_MCP_XOXC_TOKEN;
  const xoxd = env.SLACK_MCP_XOXD_TOKEN || process.env.SLACK_MCP_XOXD_TOKEN;
  if (xoxc && xoxd) return { token: xoxc, cookie: `d=${xoxd}` };
  return null;
}

export async function slackAuthTest(env: Record<string, string>): Promise<SlackIdentity> {
  const creds = resolveSlackToken(env);
  if (!creds) return { ok: false, error: "no_token" };
  const cached = identityCache.get(creds.token);
  if (cached) return cached;
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (creds.cookie) headers.Cookie = creds.cookie;
    const resp = await fetch("https://slack.com/api/auth.test", { method: "POST", headers });
    const data = (await resp.json()) as SlackIdentity;
    if (data.ok) identityCache.set(creds.token, data);
    return data;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Best-effort user-name lookup (users.info). The caller (resolveMentions) owns
// the display-name cache; this just resolves a single id on demand.
export async function fetchUserName(userId: string, env: Record<string, string>): Promise<string | null> {
  const creds = resolveSlackToken(env);
  if (!creds) return null;
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${creds.token}` };
    if (creds.cookie) headers.Cookie = creds.cookie;
    const resp = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, { headers });
    const data = (await resp.json()) as {
      ok: boolean;
      user?: { name?: string; profile?: { display_name?: string; real_name?: string } };
    };
    if (!data.ok || !data.user) return null;
    const u = data.user;
    return u.profile?.display_name || u.profile?.real_name || u.name || null;
  } catch {
    return null;
  }
}
