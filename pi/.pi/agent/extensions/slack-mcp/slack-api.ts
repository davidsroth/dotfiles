// =============================================================================
// Small, read-only Slack Web API client used by composite Slack tools
// =============================================================================

import { resolveSlackToken } from "./identity";

export type SlackFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

export interface SlackWebApiResponse {
  ok: boolean;
  error?: string;
  warning?: string;
  response_metadata?: {
    next_cursor?: string;
    warnings?: string[];
  };
}

export interface SlackHistoryMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  username?: string;
  text?: string;
  subtype?: string;
  bot_profile?: { name?: string };
}

export interface ConversationHistoryArgs {
  channelId: string;
  oldest: string;
  latest: string;
  inclusive?: boolean;
  pageSize?: number;
  maxPages?: number;
}

export interface ConversationHistoryResult {
  messages: SlackHistoryMessage[];
  pagesFetched: number;
  complete: boolean;
  nextCursor?: string;
  warnings: string[];
}

const READ_ONLY_METHODS = new Set([
  "conversations.history",
  "conversations.info",
  "conversations.replies",
  "users.info",
]);

const HARD_MAX_PAGES = 50;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Expected a positive integer, got ${String(value)}`);
  }
  return Math.min(value, maximum);
}

/**
 * Call an explicitly allowlisted read-only Slack Web API method.
 *
 * GET is intentional: arguments stay ordinary query parameters and this helper
 * cannot accidentally become a posting primitive. Browser-session credentials
 * receive the same `d` cookie as the extension's existing auth.test helper.
 */
export async function callSlackWebApi<T extends SlackWebApiResponse>(
  authEnv: Record<string, string>,
  method: string,
  args: Record<string, string | number | boolean | undefined>,
  fetchImpl: SlackFetch = globalThis.fetch as SlackFetch,
): Promise<T> {
  if (!READ_ONLY_METHODS.has(method)) {
    throw new Error(`Slack Web API method '${method}' is not allowlisted as read-only`);
  }

  const credentials = resolveSlackToken(authEnv);
  if (!credentials) throw new Error("No Slack credentials are configured for Web API context retrieval");

  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${credentials.token}` };
  if (credentials.cookie) headers.Cookie = credentials.cookie;

  let response: Pick<Response, "ok" | "status" | "json">;
  try {
    response = await fetchImpl(url, { method: "GET", headers });
  } catch (error) {
    throw new Error(`Slack Web API ${method} request failed: ${errorMessage(error)}`);
  }

  if (response.ok === false) {
    throw new Error(`Slack Web API ${method} returned HTTP ${response.status}`);
  }

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch (error) {
    throw new Error(`Slack Web API ${method} returned invalid JSON: ${errorMessage(error)}`);
  }
  if (!data.ok) throw new Error(`Slack Web API ${method} failed: ${data.error ?? "unknown_error"}`);
  return data;
}

/** Fetch an exact, inclusive history window while retaining cursor completeness. */
export async function fetchConversationHistory(
  authEnv: Record<string, string>,
  args: ConversationHistoryArgs,
  fetchImpl: SlackFetch = globalThis.fetch as SlackFetch,
): Promise<ConversationHistoryResult> {
  if (!args.channelId) throw new Error("channelId is required");
  if (!args.oldest || !args.latest) throw new Error("oldest and latest are required");

  const oldest = Number(args.oldest);
  const latest = Number(args.latest);
  if (!Number.isFinite(oldest) || !Number.isFinite(latest) || oldest > latest) {
    throw new Error("oldest and latest must be valid Slack timestamps with oldest <= latest");
  }

  const maxPages = positiveInteger(args.maxPages, 5, HARD_MAX_PAGES);
  const pageSize = positiveInteger(args.pageSize, 100, 100);
  const inclusive = args.inclusive ?? true;
  const messages: SlackHistoryMessage[] = [];
  const warnings: string[] = [];
  const seenCursors = new Set<string>();
  let cursor = "";
  let pagesFetched = 0;
  let complete = false;

  while (pagesFetched < maxPages) {
    const page = await callSlackWebApi<SlackWebApiResponse & {
      messages?: SlackHistoryMessage[];
      has_more?: boolean;
    }>(
      authEnv,
      "conversations.history",
      {
        channel: args.channelId,
        oldest: args.oldest,
        latest: args.latest,
        inclusive,
        limit: pageSize,
        cursor: cursor || undefined,
      },
      fetchImpl,
    );
    pagesFetched++;
    if (Array.isArray(page.messages)) messages.push(...page.messages);
    if (page.warning) warnings.push(page.warning);
    if (page.response_metadata?.warnings) warnings.push(...page.response_metadata.warnings);

    const nextCursor = page.response_metadata?.next_cursor?.trim() ?? "";
    if (!nextCursor) {
      complete = true;
      cursor = "";
      break;
    }
    if (seenCursors.has(nextCursor)) {
      warnings.push("Slack returned a repeated history cursor; pagination stopped to avoid a loop.");
      cursor = nextCursor;
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (!complete && cursor && pagesFetched >= maxPages) {
    warnings.push(`History pagination stopped at maxPages=${maxPages}; more context is available.`);
  }

  const deduped = new Map<string, SlackHistoryMessage>();
  for (const message of messages) {
    if (!message || typeof message.ts !== "string" || !message.ts) continue;
    const timestamp = Number(message.ts);
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp < oldest || timestamp > latest) continue;
    if (!deduped.has(message.ts)) deduped.set(message.ts, message);
  }

  return {
    messages: [...deduped.values()].sort((a, b) => Number(a.ts) - Number(b.ts)),
    pagesFetched,
    complete,
    ...(cursor ? { nextCursor: cursor } : {}),
    warnings: [...new Set(warnings)],
  };
}
