// =============================================================================
// Composite, read-only Slack activity tools
// =============================================================================

import { slackAuthTest } from "./identity";
import { parseCSV } from "./postprocess";
import { fetchConversationHistory, type SlackHistoryMessage } from "./slack-api";

export interface SlackToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export interface StructuredSearchFilters {
  filter_in_channel?: string;
  filter_in_im_or_mpim?: string;
  filter_users_with?: string;
  filter_users_from?: string;
  filter_date_before?: string;
  filter_date_after?: string;
  filter_date_on?: string;
  filter_date_during?: string;
  filter_threads_only?: boolean;
}

export interface SlackMessageRow {
  messageTs: string;
  channelId: string;
  channelLabel: string;
  threadTs?: string;
  userId?: string;
  userName?: string;
  realName?: string;
  botName?: string;
  text: string;
  time?: string;
  permalink?: string;
}

export interface ParsedSlackCsv {
  messages: SlackMessageRow[];
  cursor?: string;
  invalidRows: number;
}

export interface CompactSlackMessage {
  channelId: string;
  channelLabel: string;
  messageTs: string;
  threadTs?: string;
  time: string;
  author: {
    id?: string;
    label: string;
    userName?: string;
    realName?: string;
    isAuthenticatedUser?: boolean;
  };
  text: string;
  textLength: number;
  truncated: boolean;
  permalink?: string;
  isThreadReply: boolean;
  matchedQueries?: string[];
}

export interface MyConversationsArgs extends StructuredSearchFilters {
  searchQuery?: string;
  search_query?: string;
  filters?: StructuredSearchFilters;
  start?: string | number | Date;
  start_time?: string | number | Date;
  end?: string | number | Date;
  end_time?: string | number | Date;
  granularity?: "conversation" | "thread";
  lookbackHours?: number;
  lookback_hours?: number;
  now?: string | number | Date;
  pageSize?: number;
  page_size?: number;
  maxPages?: number;
  max_pages?: number;
  maxResults?: number;
  max_results?: number;
  snippetLength?: number;
  snippet_length?: number;
}

export interface SearchBatchArgs extends StructuredSearchFilters {
  queries: string[];
  filters?: StructuredSearchFilters;
  start?: string | number | Date;
  start_time?: string | number | Date;
  end?: string | number | Date;
  end_time?: string | number | Date;
  pageSize?: number;
  page_size?: number;
  maxPages?: number;
  max_pages?: number;
  maxResults?: number;
  max_results?: number;
  snippetLength?: number;
  snippet_length?: number;
  concurrency?: number;
}

export type OpenMessageContext = "auto" | "thread" | "around";

export interface OpenMessageArgs {
  permalink?: string;
  url?: string;
  context?: OpenMessageContext;
  oldest?: string | number | Date;
  latest?: string | number | Date;
  beforeSeconds?: number;
  before_seconds?: number;
  afterSeconds?: number;
  after_seconds?: number;
  pageSize?: number;
  page_size?: number;
  maxPages?: number;
  max_pages?: number;
  snippetLength?: number;
  snippet_length?: number;
}

export type ThreadReference = string | (OpenMessageArgs & ({ permalink: string } | { url: string }));

export interface ThreadsGetManyArgs {
  refs: ThreadReference[];
  concurrency?: number;
  maxPages?: number;
  max_pages?: number;
  pageSize?: number;
  page_size?: number;
  snippetLength?: number;
  snippet_length?: number;
}

export interface SlackPermalinkReference {
  permalink: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
}

const SEARCH_TOOL = "conversations_search_messages";
const REPLIES_TOOL = "conversations_replies";
const HARD_MAX_PAGES = 50;
const HARD_MAX_RESULTS = 1_000;
const HARD_MAX_CONCURRENCY = 8;
const DEFAULT_SNIPPET_LENGTH = 280;

const SEARCH_FILTER_KEYS: Array<keyof StructuredSearchFilters> = [
  "filter_in_channel",
  "filter_in_im_or_mpim",
  "filter_users_with",
  "filter_users_from",
  "filter_date_before",
  "filter_date_after",
  "filter_date_on",
  "filter_date_during",
  "filter_threads_only",
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return Math.min(value, maximum);
}

function timestampMillis(value: string | number | Date, name: string): number {
  if (value instanceof Date) {
    const millis = value.getTime();
    if (Number.isFinite(millis)) return millis;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return Math.abs(value) < 1e12 ? value * 1_000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1_000 : numeric;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`${name} must be an ISO date, Slack timestamp, epoch value, or Date`);
}

function slackTimestampFromMillis(millis: number): string {
  return (millis / 1_000).toFixed(6);
}

function isoFromMessage(message: SlackMessageRow): string {
  if (message.time) {
    const millis = Date.parse(message.time);
    if (Number.isFinite(millis)) return new Date(millis).toISOString();
  }
  return new Date(timestampMillis(message.messageTs, "message timestamp")).toISOString();
}

function messageMillis(message: SlackMessageRow): number | null {
  try {
    // MsgID is Slack's microsecond timestamp. The rendered Time column is only
    // second-precision in pinned upstream 1.3.0 and cannot enforce exact bounds.
    return timestampMillis(message.messageTs, "message timestamp");
  } catch {
    try {
      return message.time ? timestampMillis(message.time, "message time") : null;
    } catch {
      return null;
    }
  }
}

function normalizeHeader(header: string): string {
  return header.replace(/^\uFEFF/, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function findColumn(headers: string[], ...aliases: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const index = normalized.indexOf(normalizeHeader(alias));
    if (index >= 0) return index;
  }
  return -1;
}

function channelParts(raw: string): { id: string; label: string } {
  const value = raw.trim();
  const idMatch = value.match(/(?:^|\s)([CDG][A-Z0-9]+)(?:\s|$|\s*\()/i);
  const id = idMatch?.[1] ?? value;
  const labelMatch = value.match(/\(([^()]*)\)\s*$/);
  return { id, label: labelMatch?.[1]?.trim() || value || id };
}

function noRowsText(text: string): boolean {
  return /^(?:no\s+(?:messages|results)|nothing\s+found)/i.test(text.trim());
}

/** Parse the upstream's raw RFC4180 message CSV without discarding Cursor. */
export function parseSlackMessageCsv(text: string): ParsedSlackCsv {
  const footerCursor = text.match(/(?:^|\n)next_cursor:\s*([^\s]+)\s*$/im)?.[1];
  if (!text.trim() || noRowsText(text)) return { messages: [], invalidRows: 0, ...(footerCursor ? { cursor: footerCursor } : {}) };

  const rows = parseCSV(text);
  if (!rows) throw new Error("Slack returned malformed message CSV");

  const headerIndex = rows.findIndex((row) => {
    const values = row.map(normalizeHeader);
    return values.includes("msgid") && values.some((value) => value === "channel" || value === "channelid");
  });
  if (headerIndex < 0) throw new Error("Slack response did not contain a message CSV header");

  const header = rows[headerIndex];
  const msgIndex = findColumn(header, "MsgID", "MessageTS", "Timestamp", "ts");
  const channelIndex = findColumn(header, "Channel", "ChannelID", "channel_id");
  const threadIndex = findColumn(header, "ThreadTs", "ThreadTS", "thread_ts");
  const userIndex = findColumn(header, "UserID", "user_id");
  const userNameIndex = findColumn(header, "UserName", "user_user", "Username");
  const realNameIndex = findColumn(header, "RealName", "real_name");
  const botNameIndex = findColumn(header, "BotName", "bot_name");
  const textIndex = findColumn(header, "Text", "text");
  const timeIndex = findColumn(header, "Time", "time");
  const permalinkIndex = findColumn(header, "Permalink", "permalink");
  const cursorIndex = findColumn(header, "Cursor", "cursor");
  const messages: SlackMessageRow[] = [];
  let cursor = footerCursor ?? "";
  let invalidRows = 0;

  for (const row of rows.slice(headerIndex + 1)) {
    if (row.length !== header.length) {
      if (row.some((field) => field.trim())) invalidRows++;
      continue;
    }
    if (cursorIndex >= 0 && row[cursorIndex]?.trim()) cursor = row[cursorIndex].trim();
    const messageTs = row[msgIndex]?.trim();
    const rawChannel = row[channelIndex]?.trim();
    if (!messageTs || !rawChannel) {
      if (row.some((field) => field.trim())) invalidRows++;
      continue;
    }
    const channel = channelParts(rawChannel);
    messages.push({
      messageTs,
      channelId: channel.id,
      channelLabel: channel.label,
      ...(threadIndex >= 0 && row[threadIndex]?.trim() ? { threadTs: row[threadIndex].trim() } : {}),
      ...(userIndex >= 0 && row[userIndex]?.trim() ? { userId: row[userIndex].trim() } : {}),
      ...(userNameIndex >= 0 && row[userNameIndex]?.trim() ? { userName: row[userNameIndex].trim() } : {}),
      ...(realNameIndex >= 0 && row[realNameIndex]?.trim() ? { realName: row[realNameIndex].trim() } : {}),
      ...(botNameIndex >= 0 && row[botNameIndex]?.trim() ? { botName: row[botNameIndex].trim() } : {}),
      text: textIndex >= 0 ? row[textIndex] ?? "" : "",
      ...(timeIndex >= 0 && row[timeIndex]?.trim() ? { time: row[timeIndex].trim() } : {}),
      ...(permalinkIndex >= 0 && row[permalinkIndex]?.trim() ? { permalink: row[permalinkIndex].trim() } : {}),
    });
  }

  return { messages, invalidRows, ...(cursor ? { cursor } : {}) };
}

export function messageKey(message: SlackMessageRow): string {
  return `${message.channelId}\u0000${message.messageTs}`;
}

function mergeMessage(existing: SlackMessageRow, candidate: SlackMessageRow): SlackMessageRow {
  return {
    ...candidate,
    ...existing,
    channelLabel: existing.channelLabel || candidate.channelLabel,
    text: existing.text || candidate.text,
    threadTs: existing.threadTs || candidate.threadTs,
    userId: existing.userId || candidate.userId,
    userName: existing.userName || candidate.userName,
    realName: existing.realName || candidate.realName,
    botName: existing.botName || candidate.botName,
    time: existing.time || candidate.time,
    permalink: existing.permalink || candidate.permalink,
  };
}

export function dedupeSlackMessages(messages: SlackMessageRow[]): SlackMessageRow[] {
  const byKey = new Map<string, SlackMessageRow>();
  for (const message of messages) {
    const key = messageKey(message);
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeMessage(existing, message) : message);
  }
  return [...byKey.values()];
}

/** Exact local interval predicate: start is inclusive and end is exclusive. */
export function isMessageInWindow(message: SlackMessageRow, startMs?: number, endMs?: number): boolean {
  const time = messageMillis(message);
  if (time === null) return false;
  return (startMs === undefined || time >= startMs) && (endMs === undefined || time < endMs);
}

function compactText(text: string, maximum: number): { text: string; textLength: number; truncated: boolean } {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximum) return { text: normalized, textLength: normalized.length, truncated: false };
  return {
    text: `${normalized.slice(0, Math.max(1, maximum - 1))}…`,
    textLength: normalized.length,
    truncated: true,
  };
}

export function compactSlackMessage(
  message: SlackMessageRow,
  options: { snippetLength?: number; authenticatedUserId?: string; matchedQueries?: string[] } = {},
): CompactSlackMessage {
  const snippetLength = boundedInteger(options.snippetLength, DEFAULT_SNIPPET_LENGTH, 2_000, "snippetLength");
  const snippet = compactText(message.text, snippetLength);
  const label = message.realName || message.userName || message.botName || message.userId || "unknown author";
  return {
    channelId: message.channelId,
    channelLabel: message.channelLabel,
    messageTs: message.messageTs,
    ...(message.threadTs ? { threadTs: message.threadTs } : {}),
    time: isoFromMessage(message),
    author: {
      ...(message.userId ? { id: message.userId } : {}),
      label,
      ...(message.userName ? { userName: message.userName } : {}),
      ...(message.realName ? { realName: message.realName } : {}),
      ...(options.authenticatedUserId
        ? { isAuthenticatedUser: message.userId === options.authenticatedUserId }
        : {}),
    },
    ...snippet,
    ...(message.permalink ? { permalink: message.permalink } : {}),
    isThreadReply: Boolean(message.threadTs && message.threadTs !== message.messageTs),
    ...(options.matchedQueries ? { matchedQueries: options.matchedQueries } : {}),
  };
}

function collectFilters(args: StructuredSearchFilters & { filters?: StructuredSearchFilters }): StructuredSearchFilters {
  const result: StructuredSearchFilters = {};
  for (const source of [args.filters ?? {}, args]) {
    for (const key of SEARCH_FILTER_KEYS) {
      const value = source[key];
      if (value !== undefined && value !== "") (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

function utcDateOffset(millis: number, days: number): string {
  const date = new Date(millis);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addSafeCoarseDateFilters(filters: StructuredSearchFilters, startMs?: number, endMs?: number): void {
  const hasDateFilter = Boolean(
    filters.filter_date_after || filters.filter_date_before || filters.filter_date_on || filters.filter_date_during,
  );
  if (hasDateFilter) return;
  // Slack's before/after operators are date-granular and exclusive. Expand by
  // one UTC day on each side, then enforce the exact interval locally.
  if (startMs !== undefined) filters.filter_date_after = utcDateOffset(startMs, -1);
  if (endMs !== undefined) filters.filter_date_before = utcDateOffset(endMs, 1);
}

async function callUpstream(caller: SlackToolCaller, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await caller.callTool(name, args);
  if (result.isError) throw new Error(result.text || `${name} failed`);
  return result.text;
}

interface PaginatedSearchResult {
  messages: SlackMessageRow[];
  pagesFetched: number;
  complete: boolean;
  warnings: string[];
  error?: string;
}

async function paginateSearch(
  caller: SlackToolCaller,
  baseArgs: Record<string, unknown>,
  maxPages: number,
): Promise<PaginatedSearchResult> {
  const messages: SlackMessageRow[] = [];
  const warnings: string[] = [];
  const seenCursors = new Set<string>();
  let cursor = "";
  let pagesFetched = 0;
  let complete = false;
  let error: string | undefined;

  while (pagesFetched < maxPages) {
    const pageArgs = { ...baseArgs, ...(cursor ? { cursor } : {}) };
    try {
      const parsed = parseSlackMessageCsv(await callUpstream(caller, SEARCH_TOOL, pageArgs));
      pagesFetched++;
      messages.push(...parsed.messages);
      if (parsed.invalidRows > 0) warnings.push(`Ignored ${parsed.invalidRows} malformed CSV row(s) on page ${pagesFetched}.`);
      const nextCursor = parsed.cursor?.trim() ?? "";
      if (!nextCursor) {
        complete = true;
        cursor = "";
        break;
      }
      if (seenCursors.has(nextCursor)) {
        warnings.push("Slack returned a repeated search cursor; pagination stopped to avoid a loop.");
        cursor = nextCursor;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } catch (caught) {
      error = errorMessage(caught);
      warnings.push(`Search pagination failed${pagesFetched ? ` after ${pagesFetched} page(s)` : ""}: ${error}`);
      break;
    }
  }

  if (!complete && cursor && pagesFetched >= maxPages) {
    warnings.push(`Search pagination stopped at maxPages=${maxPages}; more matches are available.`);
  }
  return { messages: dedupeSlackMessages(messages), pagesFetched, complete, warnings, ...(error ? { error } : {}) };
}

function sortedNewest(messages: SlackMessageRow[]): SlackMessageRow[] {
  return [...messages].sort((a, b) => (messageMillis(b) ?? 0) - (messageMillis(a) ?? 0));
}

function resultLimit(messages: SlackMessageRow[], maxResults: number): { messages: SlackMessageRow[]; truncated: boolean } {
  return messages.length > maxResults
    ? { messages: messages.slice(0, maxResults), truncated: true }
    : { messages, truncated: false };
}

function groupMyMessages(
  messages: CompactSlackMessage[],
  authenticatedUserId: string,
  granularity: "conversation" | "thread",
) {
  const groups = new Map<string, {
    key: string;
    kind: "thread" | "conversation";
    label: string;
    channelId: string;
    channelLabel: string;
    threadTs?: string;
    participantIds: string[];
    participants: Array<{ id?: string; label: string; isAuthenticatedUser: boolean }>;
    authorship: { authenticatedUserId: string; myMessageCount: number; allMessagesByAuthenticatedUser: boolean };
    messages: CompactSlackMessage[];
  }>();

  for (const message of messages) {
    const threadTs = granularity === "thread" ? message.threadTs : undefined;
    const key = threadTs ? `${message.channelId}:thread:${threadTs}` : `${message.channelId}:conversation`;
    let group = groups.get(key);
    if (!group) {
      const kind = threadTs ? "thread" : "conversation";
      group = {
        key,
        kind,
        label: `${kind === "thread" ? "Thread" : "Conversation"} in ${message.channelLabel}`,
        channelId: message.channelId,
        channelLabel: message.channelLabel,
        ...(threadTs ? { threadTs } : {}),
        participantIds: [],
        participants: [],
        authorship: { authenticatedUserId, myMessageCount: 0, allMessagesByAuthenticatedUser: true },
        messages: [],
      };
      groups.set(key, group);
    }
    group.messages.push(message);
    if (message.author.id && !group.participantIds.includes(message.author.id)) group.participantIds.push(message.author.id);
    if (!group.participants.some((participant) => participant.id === message.author.id && participant.label === message.author.label)) {
      group.participants.push({
        ...(message.author.id ? { id: message.author.id } : {}),
        label: message.author.label,
        isAuthenticatedUser: message.author.id === authenticatedUserId,
      });
    }
    if (message.author.id === authenticatedUserId) group.authorship.myMessageCount++;
    else group.authorship.allMessagesByAuthenticatedUser = false;
  }

  return [...groups.values()];
}

export async function runMyConversations(
  caller: SlackToolCaller,
  authEnv: Record<string, string>,
  args: MyConversationsArgs = {},
) {
  const identity = await slackAuthTest(authEnv);
  if (!identity.ok || !identity.user_id) {
    throw new Error(`Slack auth.test failed: ${identity.error ?? "authenticated user_id was missing"}`);
  }

  const nowMs = args.now === undefined ? Date.now() : timestampMillis(args.now, "now");
  const endValue = args.end_time ?? args.end;
  const endMs = endValue === undefined ? nowMs : timestampMillis(endValue, "end_time");
  const lookbackHours = args.lookbackHours ?? args.lookback_hours ?? 24;
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) throw new Error("lookbackHours must be positive");
  const startValue = args.start_time ?? args.start;
  const startMs = startValue === undefined ? endMs - lookbackHours * 3_600_000 : timestampMillis(startValue, "start_time");
  if (startMs >= endMs) throw new Error("start must be earlier than end");

  const pageSize = boundedInteger(args.pageSize ?? args.page_size, 100, 100, "pageSize");
  const maxPages = boundedInteger(args.maxPages ?? args.max_pages, 5, HARD_MAX_PAGES, "maxPages");
  const maxResults = boundedInteger(args.maxResults ?? args.max_results, 200, HARD_MAX_RESULTS, "maxResults");
  const filters = collectFilters(args);
  filters.filter_users_from = identity.user_id;
  addSafeCoarseDateFilters(filters, startMs, endMs);

  const paginated = await paginateSearch(caller, {
    search_query: (args.searchQuery ?? args.search_query)?.trim() ?? "",
    ...filters,
    limit: pageSize,
    _raw: true,
  }, maxPages);
  if (paginated.pagesFetched === 0 && paginated.error) throw new Error(paginated.error);

  const exact = sortedNewest(paginated.messages.filter((message) => isMessageInWindow(message, startMs, endMs)));
  const limited = resultLimit(exact, maxResults);
  const warnings = [...paginated.warnings];
  if (limited.truncated) warnings.push(`Result output was limited to maxResults=${maxResults}.`);
  const compact = limited.messages.map((message) => compactSlackMessage(message, {
    snippetLength: args.snippetLength ?? args.snippet_length,
    authenticatedUserId: identity.user_id,
  }));

  return {
    authenticatedUser: {
      id: identity.user_id,
      name: identity.user,
      team: identity.team,
      teamId: identity.team_id,
    },
    window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), semantics: "start <= MsgID < end" },
    granularity: args.granularity ?? "thread",
    groups: groupMyMessages(compact, identity.user_id, args.granularity ?? "thread"),
    messages: compact,
    messageCount: compact.length,
    pagesFetched: paginated.pagesFetched,
    complete: paginated.complete && !limited.truncated,
    warnings: [...new Set(warnings)],
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function runWorker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return results;
}

export async function runSearchBatch(caller: SlackToolCaller, args: SearchBatchArgs) {
  if (!Array.isArray(args.queries) || args.queries.length < 1 || args.queries.length > 20) {
    throw new Error("queries must contain between 1 and 20 lexical variants");
  }
  const queries = args.queries.map((query) => query.trim());
  if (queries.some((query) => !query)) throw new Error("queries must not contain empty variants");
  if (new Set(queries).size !== queries.length) throw new Error("queries must contain distinct lexical variants");

  const startValue = args.start_time ?? args.start;
  const endValue = args.end_time ?? args.end;
  const startMs = startValue === undefined ? undefined : timestampMillis(startValue, "start_time");
  const endMs = endValue === undefined ? undefined : timestampMillis(endValue, "end_time");
  if (startMs !== undefined && endMs !== undefined && startMs >= endMs) throw new Error("start must be earlier than end");
  const pageSize = boundedInteger(args.pageSize ?? args.page_size, 100, 100, "pageSize");
  const maxPages = boundedInteger(args.maxPages ?? args.max_pages, 3, HARD_MAX_PAGES, "maxPages");
  const maxResults = boundedInteger(args.maxResults ?? args.max_results, 300, HARD_MAX_RESULTS, "maxResults");
  const concurrency = boundedInteger(args.concurrency, 4, HARD_MAX_CONCURRENCY, "concurrency");
  const filters = collectFilters(args);
  addSafeCoarseDateFilters(filters, startMs, endMs);

  const queryRuns = await mapWithConcurrency(queries, concurrency, async (query, queryIndex) => {
    const paginated = await paginateSearch(caller, {
      search_query: query,
      ...filters,
      limit: pageSize,
      _raw: true,
    }, maxPages);
    const exact = paginated.messages.filter((message) => isMessageInWindow(message, startMs, endMs));
    return { query, queryIndex, ...paginated, messages: exact };
  });

  const byMessage = new Map<string, { message: SlackMessageRow; matchedQueries: string[] }>();
  for (const run of queryRuns) {
    for (const message of run.messages) {
      const key = messageKey(message);
      const existing = byMessage.get(key);
      if (existing) {
        existing.message = mergeMessage(existing.message, message);
        if (!existing.matchedQueries.includes(run.query)) existing.matchedQueries.push(run.query);
      } else {
        byMessage.set(key, { message, matchedQueries: [run.query] });
      }
    }
  }

  const ordered = [...byMessage.values()].sort((a, b) => (messageMillis(b.message) ?? 0) - (messageMillis(a.message) ?? 0));
  const truncated = ordered.length > maxResults;
  const selected = truncated ? ordered.slice(0, maxResults) : ordered;
  const warnings = queryRuns.flatMap((run) => run.warnings.map((warning) => `[${run.query}] ${warning}`));
  if (truncated) warnings.push(`Deduplicated batch output was limited to maxResults=${maxResults}.`);

  return {
    ...(startMs !== undefined || endMs !== undefined ? {
      window: {
        ...(startMs !== undefined ? { start: new Date(startMs).toISOString() } : {}),
        ...(endMs !== undefined ? { end: new Date(endMs).toISOString() } : {}),
        semantics: "start <= MsgID < end",
      },
    } : {}),
    messages: selected.map(({ message, matchedQueries }) => compactSlackMessage(message, {
      snippetLength: args.snippetLength ?? args.snippet_length,
      matchedQueries,
    })),
    messageCount: selected.length,
    queryResults: queryRuns.map((run) => ({
      query: run.query,
      queryIndex: run.queryIndex,
      matchedCount: run.messages.length,
      pagesFetched: run.pagesFetched,
      complete: run.complete,
      ...(run.error ? { error: run.error } : {}),
      warnings: run.warnings,
    })),
    pagesFetched: queryRuns.reduce((sum, run) => sum + run.pagesFetched, 0),
    complete: !truncated && queryRuns.every((run) => run.complete),
    warnings: [...new Set(warnings)],
  };
}

/** Parse an ordinary Slack /archives/{channel}/p{timestamp} permalink locally. */
export function parseSlackPermalink(permalink: string): SlackPermalinkReference {
  let url: URL;
  try {
    url = new URL(permalink);
  } catch {
    throw new Error("permalink must be a valid URL");
  }
  if (!/(?:^|\.)slack(?:-gov)?\.com$/i.test(url.hostname)) {
    throw new Error("permalink must use a slack.com or slack-gov.com host");
  }
  const match = url.pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d{11,})/i);
  if (!match) throw new Error("permalink must contain /archives/{channel}/p{timestamp}");
  const digits = match[2];
  const messageTs = `${digits.slice(0, 10)}.${digits.slice(10).padEnd(6, "0").slice(0, 6)}`;
  const threadTs = url.searchParams.get("thread_ts")?.trim() || undefined;
  if (threadTs && !/^\d+\.\d+$/.test(threadTs)) throw new Error("permalink contains an invalid thread_ts");
  return { permalink, channelId: match[1], messageTs, ...(threadTs ? { threadTs } : {}) };
}

export function isDirectConversation(channelId: string): boolean {
  // D = IM. G is Slack's MPIM (and some legacy private-channel) namespace;
  // around-history is the conservative choice because it cannot omit adjacent,
  // unthreaded responses the way replies-only can.
  return /^[DG]/i.test(channelId);
}

function historyMessageToRow(message: SlackHistoryMessage, channelId: string, channelLabel: string): SlackMessageRow {
  return {
    messageTs: message.ts,
    channelId,
    channelLabel,
    ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
    ...(message.user ? { userId: message.user } : {}),
    ...(message.username ? { userName: message.username } : {}),
    ...(message.bot_profile?.name ? { botName: message.bot_profile.name } : {}),
    text: message.text ?? "",
  };
}

async function paginateReplies(
  caller: SlackToolCaller,
  channelId: string,
  threadTs: string,
  pageSize: number,
  maxPages: number,
): Promise<PaginatedSearchResult> {
  const messages: SlackMessageRow[] = [];
  const warnings: string[] = [];
  const seenCursors = new Set<string>();
  let cursor = "";
  let pagesFetched = 0;
  let complete = false;
  let error: string | undefined;

  while (pagesFetched < maxPages) {
    const pageArgs: Record<string, unknown> = {
      channel_id: channelId,
      thread_ts: threadTs,
      _raw: true,
      ...(cursor ? { cursor } : { limit: String(pageSize) }),
    };
    try {
      const parsed = parseSlackMessageCsv(await callUpstream(caller, REPLIES_TOOL, pageArgs));
      pagesFetched++;
      messages.push(...parsed.messages);
      if (parsed.invalidRows > 0) warnings.push(`Ignored ${parsed.invalidRows} malformed CSV row(s) on page ${pagesFetched}.`);
      const nextCursor = parsed.cursor?.trim() ?? "";
      if (!nextCursor) {
        complete = true;
        cursor = "";
        break;
      }
      if (seenCursors.has(nextCursor)) {
        warnings.push("Slack returned a repeated replies cursor; pagination stopped to avoid a loop.");
        cursor = nextCursor;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } catch (caught) {
      error = errorMessage(caught);
      warnings.push(`Thread context retrieval failed${pagesFetched ? ` after ${pagesFetched} page(s)` : ""}: ${error}`);
      break;
    }
  }
  if (!complete && cursor && pagesFetched >= maxPages) {
    warnings.push(`Thread pagination stopped at maxPages=${maxPages}; more replies are available.`);
  }
  return { messages: dedupeSlackMessages(messages), pagesFetched, complete, warnings, ...(error ? { error } : {}) };
}

function exactMessageFromSearch(parsed: ParsedSlackCsv, ref: SlackPermalinkReference): SlackMessageRow {
  const exact = parsed.messages.find((message) => message.channelId === ref.channelId && message.messageTs === ref.messageTs)
    ?? parsed.messages.find((message) => message.messageTs === ref.messageTs);
  if (!exact) throw new Error("Slack permalink search did not return the exact referenced message");
  return exact;
}

export async function runOpenMessage(
  caller: SlackToolCaller,
  authEnv: Record<string, string>,
  args: OpenMessageArgs,
) {
  const permalink = args.url ?? args.permalink;
  if (!permalink) throw new Error("url (Slack permalink) is required");
  const ref = parseSlackPermalink(permalink);
  const exactSearch = parseSlackMessageCsv(await callUpstream(caller, SEARCH_TOOL, {
    search_query: permalink,
    limit: 100,
    _raw: true,
  }));
  const exact = exactMessageFromSearch(exactSearch, ref);
  const pageSize = boundedInteger(args.pageSize ?? args.page_size, 100, 100, "pageSize");
  const maxPages = boundedInteger(args.maxPages ?? args.max_pages, 5, HARD_MAX_PAGES, "maxPages");
  const direct = isDirectConversation(ref.channelId);
  const useAroundHistory = direct || args.context === "around";
  const warnings: string[] = [];
  if (exactSearch.invalidRows) warnings.push(`Ignored ${exactSearch.invalidRows} malformed row(s) while resolving the permalink.`);

  let contextRows: SlackMessageRow[] = [];
  let contextPagesFetched = 0;
  let complete = false;
  let contextSource: "history" | "replies" | "search-only" = "search-only";

  if (useAroundHistory) {
    const targetMs = timestampMillis(ref.messageTs, "permalink timestamp");
    const beforeSeconds = args.beforeSeconds ?? args.before_seconds ?? 86_400;
    const afterSeconds = args.afterSeconds ?? args.after_seconds ?? 86_400;
    if (!Number.isFinite(beforeSeconds) || beforeSeconds < 0 || !Number.isFinite(afterSeconds) || afterSeconds < 0) {
      throw new Error("beforeSeconds and afterSeconds must be non-negative");
    }
    const oldest = args.oldest === undefined
      ? slackTimestampFromMillis(targetMs - beforeSeconds * 1_000)
      : slackTimestampFromMillis(timestampMillis(args.oldest, "oldest"));
    const latest = args.latest === undefined
      ? slackTimestampFromMillis(targetMs + afterSeconds * 1_000)
      : slackTimestampFromMillis(timestampMillis(args.latest, "latest"));
    try {
      const history = await fetchConversationHistory(authEnv, {
        channelId: ref.channelId,
        oldest,
        latest,
        inclusive: true,
        pageSize,
        maxPages,
      });
      contextRows = history.messages.map((message) => historyMessageToRow(message, ref.channelId, exact.channelLabel));
      contextPagesFetched = history.pagesFetched;
      complete = history.complete;
      contextSource = "history";
      warnings.push(...history.warnings);
    } catch (caught) {
      warnings.push(`Around-context retrieval failed; returning the exact search result only: ${errorMessage(caught)}`);
    }
  } else {
    const rootTs = ref.threadTs || exact.threadTs || exact.messageTs;
    const replies = await paginateReplies(caller, ref.channelId, rootTs, pageSize, maxPages);
    contextRows = replies.messages;
    contextPagesFetched = replies.pagesFetched;
    complete = replies.complete;
    contextSource = replies.pagesFetched > 0 ? "replies" : "search-only";
    warnings.push(...replies.warnings);
  }

  const context = dedupeSlackMessages([...contextRows, exact]).sort((a, b) => (messageMillis(a) ?? 0) - (messageMillis(b) ?? 0));
  return {
    reference: ref,
    conversationType: direct ? (ref.channelId.startsWith("D") ? "dm" : "mpdm") : "channel",
    contextSource,
    exactMessage: compactSlackMessage(exact, { snippetLength: args.snippetLength ?? args.snippet_length }),
    context: context.map((message) => compactSlackMessage(message, {
      snippetLength: args.snippetLength ?? args.snippet_length,
    })),
    searchPagesFetched: 1,
    contextPagesFetched,
    pagesFetched: 1 + contextPagesFetched,
    complete,
    warnings: [...new Set(warnings)],
  };
}

export async function runThreadsGetMany(
  caller: SlackToolCaller,
  authEnv: Record<string, string>,
  args: ThreadsGetManyArgs,
) {
  if (!Array.isArray(args.refs) || args.refs.length < 1 || args.refs.length > 30) {
    throw new Error("refs must contain between 1 and 30 Slack message references");
  }
  const concurrency = boundedInteger(args.concurrency, 4, HARD_MAX_CONCURRENCY, "concurrency");
  const results = await mapWithConcurrency(args.refs, concurrency, async (reference, index) => {
    const openArgs: OpenMessageArgs = typeof reference === "string" ? { url: reference } : reference;
    const merged: OpenMessageArgs = {
      ...openArgs,
      ...(openArgs.maxPages === undefined && openArgs.max_pages === undefined && (args.maxPages ?? args.max_pages) !== undefined
        ? { maxPages: args.maxPages ?? args.max_pages }
        : {}),
      ...(openArgs.pageSize === undefined && openArgs.page_size === undefined && (args.pageSize ?? args.page_size) !== undefined
        ? { pageSize: args.pageSize ?? args.page_size }
        : {}),
      ...(openArgs.snippetLength === undefined && openArgs.snippet_length === undefined && (args.snippetLength ?? args.snippet_length) !== undefined
        ? { snippetLength: args.snippetLength ?? args.snippet_length }
        : {}),
    };
    try {
      const result = await runOpenMessage(caller, authEnv, merged);
      return {
        index,
        ref: openArgs.url ?? openArgs.permalink ?? "",
        result,
        complete: result.complete,
        pagesFetched: result.pagesFetched,
      };
    } catch (caught) {
      return {
        index,
        ref: openArgs.url ?? openArgs.permalink ?? "",
        error: errorMessage(caught),
        complete: false,
        pagesFetched: 0,
      };
    }
  });

  return {
    results,
    itemCount: results.length,
    pagesFetched: results.reduce((sum, result) => sum + result.pagesFetched, 0),
    complete: results.every((result) => result.complete),
    errors: results.filter((result) => "error" in result).length,
  };
}
