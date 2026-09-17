import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identityMocks = vi.hoisted(() => ({
  slackAuthTest: vi.fn(),
  resolveSlackToken: vi.fn(),
}));

vi.mock("../slack-mcp/identity", () => identityMocks);

import {
  isMessageInWindow,
  parseSlackMessageCsv,
  parseSlackPermalink,
  runMyConversations,
  runOpenMessage,
  runSearchBatch,
  runThreadsGetMany,
  type SlackToolCaller,
} from "../slack-mcp/activity";

interface CsvMessage {
  msg: string;
  channel?: string;
  thread?: string;
  user?: string;
  userName?: string;
  realName?: string;
  text?: string;
  time?: string;
  permalink?: string;
  cursor?: string;
}

function csv(messages: CsvMessage[]): string {
  const escape = (value: string) => /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const header = ["MsgID", "UserID", "UserName", "RealName", "Channel", "ThreadTs", "Text", "Time", "Permalink", "Cursor"];
  const rows = messages.map((message) => [
    message.msg,
    message.user ?? "UOTHER",
    message.userName ?? "other",
    message.realName ?? "Other User",
    message.channel ?? "C123 (#general)",
    message.thread ?? "",
    message.text ?? "hello",
    message.time ?? new Date(Number(message.msg) * 1_000).toISOString(),
    message.permalink ?? "",
    message.cursor ?? "",
  ]);
  return `${[header, ...rows].map((row) => row.map(escape).join(",")).join("\n")}\n`;
}

function callerFrom(
  implementation: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }> | { text: string; isError: boolean },
): SlackToolCaller & { callTool: ReturnType<typeof vi.fn> } {
  return { callTool: vi.fn(async (name: string, args: Record<string, unknown>) => implementation(name, args)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  identityMocks.slackAuthTest.mockResolvedValue({
    ok: true,
    user_id: "UME",
    user: "me",
    team: "Example",
    team_id: "T1",
  });
  identityMocks.resolveSlackToken.mockReturnValue({ token: "test-token" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("raw Slack CSV parsing", () => {
  it("retains quoted content and the last non-empty cursor", () => {
    const parsed = parseSlackMessageCsv(csv([
      { msg: "1700000000.000001", text: "hello, \"world\"", cursor: "" },
      { msg: "1700000001.000001", text: "second", cursor: "next-page" },
    ]));

    expect(parsed.messages.map((message) => message.text)).toEqual(["hello, \"world\"", "second"]);
    expect(parsed.cursor).toBe("next-page");
  });
});

describe("exact time filtering", () => {
  it("uses microsecond MsgID rather than the second-precision Time column", () => {
    const message = {
      messageTs: "1700000000.500000",
      channelId: "C1",
      channelLabel: "#one",
      text: "boundary",
      time: "2023-11-14T22:13:20Z",
    };
    expect(isMessageInWindow(message, 1_700_000_000_500, 1_700_000_000_501)).toBe(true);
    expect(isMessageInWindow(message, undefined, 1_700_000_000_500)).toBe(false);
  });
});

describe("runMyConversations", () => {
  it("uses exact start-inclusive/end-exclusive filtering, stable page filters, dedupe, and grouping", async () => {
    const start = "2026-08-12T10:00:00.000Z";
    const end = "2026-08-12T11:00:00.000Z";
    const startTs = String(Date.parse(start) / 1_000);
    const middleTs = String(Date.parse("2026-08-12T10:30:00.000Z") / 1_000);
    const endTs = String(Date.parse(end) / 1_000);
    const pages = [
      csv([
        { msg: startTs, user: "UME", userName: "me", realName: "Me", thread: "1775988000.000000", text: "at start" },
        { msg: middleTs, user: "UME", userName: "me", realName: "Me", text: "middle", cursor: "cursor-2" },
      ]),
      csv([
        { msg: middleTs, user: "UME", userName: "me", realName: "Me", text: "middle duplicate" },
        { msg: endTs, user: "UME", userName: "me", realName: "Me", text: "at end" },
      ]),
    ];
    const caller = callerFrom(() => ({ text: pages.shift()!, isError: false }));

    const result = await runMyConversations(caller, {}, {
      start_time: start,
      end_time: end,
      granularity: "thread",
      filter_in_channel: "#general",
      maxPages: 4,
    });

    expect(result.messages.map((message) => message.text)).toEqual(["middle", "at start"]);
    expect(result.messageCount).toBe(2);
    expect(result.groups.map((group) => group.kind).sort()).toEqual(["conversation", "thread"]);
    expect(result.groups[0].authorship.authenticatedUserId).toBe("UME");
    expect(result.complete).toBe(true);
    expect(result.pagesFetched).toBe(2);

    const firstArgs = caller.callTool.mock.calls[0][1] as Record<string, unknown>;
    const secondArgs = caller.callTool.mock.calls[1][1] as Record<string, unknown>;
    expect(firstArgs).toMatchObject({
      filter_users_from: "UME",
      filter_in_channel: "#general",
      limit: 100,
      _raw: true,
    });
    expect(secondArgs).toEqual({ ...firstArgs, cursor: "cursor-2" });
  });

  it("marks a cursor-capped result incomplete without following extra pages", async () => {
    const caller = callerFrom(() => ({
      text: csv([{ msg: "1775988000.000000", user: "UME", cursor: "still-more" }]),
      isError: false,
    }));

    const result = await runMyConversations(caller, {}, {
      start: "2026-04-12T00:00:00Z",
      end: "2026-04-13T00:00:00Z",
      maxPages: 1,
    });

    expect(caller.callTool).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toContain("maxPages=1");
  });
});

describe("runSearchBatch", () => {
  it("preserves query provenance and a query's partial pagination failure", async () => {
    const shared = {
      msg: "1775989800.000000",
      channel: "C123 (#general)",
      text: "shared match",
      time: "2026-04-12T10:30:00.000Z",
    };
    const caller = callerFrom((_name, args) => {
      const query = String(args.search_query);
      if (query === "alpha") {
        return {
          text: csv([
            shared,
            { ...shared, msg: "1775988000.000000", time: "2026-04-12T10:00:00.000Z", text: "start boundary" },
            { ...shared, msg: "1775991600.000000", time: "2026-04-12T11:00:00.000Z", text: "end boundary" },
          ]),
          isError: false,
        };
      }
      if (!args.cursor) return { text: csv([{ ...shared, cursor: "beta-2" }]), isError: false };
      return { text: "rate_limited", isError: true };
    });

    const result = await runSearchBatch(caller, {
      queries: ["alpha", "beta"],
      start: "2026-04-12T10:00:00Z",
      end: "2026-04-12T11:00:00Z",
      filter_in_channel: "#general",
      concurrency: 1,
    });

    expect(result.messages.map((message) => message.text)).toEqual(["shared match", "start boundary"]);
    expect(result.messages[0].matchedQueries).toEqual(["alpha", "beta"]);
    expect(result.queryResults[0]).toMatchObject({ query: "alpha", complete: true, pagesFetched: 1 });
    expect(result.queryResults[1]).toMatchObject({ query: "beta", complete: false, pagesFetched: 1, error: "rate_limited" });
    expect(result.complete).toBe(false);

    const betaCalls = caller.callTool.mock.calls.filter((call) => call[1].search_query === "beta");
    const { cursor: _cursor, ...secondFilters } = betaCalls[1][1] as Record<string, unknown>;
    expect(secondFilters).toEqual(betaCalls[0][1]);
  });

  it("bounds concurrency and compact output size", async () => {
    let active = 0;
    let maximumActive = 0;
    const caller = callerFrom(async (_name, args) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      const query = String(args.search_query);
      const index = Number(query.slice(1));
      return {
        text: csv([{
          msg: `${1775988000 + index}.000000`,
          channel: `C${index} (#channel-${index})`,
          text: `${query} ${"x".repeat(100)}`,
        }]),
        isError: false,
      };
    });

    const result = await runSearchBatch(caller, {
      queries: ["q1", "q2", "q3", "q4", "q5"],
      concurrency: 2,
      maxResults: 2,
      snippetLength: 20,
    });

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(result.messages).toHaveLength(2);
    expect(result.messages.every((message) => message.text.length <= 20)).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toContain("maxResults=2");
  });
});

describe("permalink opening", () => {
  const channelPermalink = "https://example.slack.com/archives/C123/p1775989800123456?thread_ts=1775988000.000001&cid=C123";
  const dmPermalink = "https://example.slack.com/archives/D123/p1775989800123456";

  it("parses channel and timestamps without a Slack request", () => {
    expect(parseSlackPermalink(channelPermalink)).toEqual({
      permalink: channelPermalink,
      channelId: "C123",
      messageTs: "1775989800.123456",
      threadTs: "1775988000.000001",
    });
  });

  it("auto-paginates channel replies and reports max-page incompleteness", async () => {
    const caller = callerFrom((name, args) => {
      if (name === "conversations_search_messages") {
        return {
          text: csv([{
            msg: "1775989800.123456",
            channel: "C123 (#general)",
            thread: "1775988000.000001",
            permalink: channelPermalink,
            text: "exact reply",
          }]),
          isError: false,
        };
      }
      expect(args.thread_ts).toBe("1775988000.000001");
      return {
        text: csv([{ msg: "1775988000.000001", channel: "C123 (#general)", cursor: "more", text: "root" }]),
        isError: false,
      };
    });

    const result = await runOpenMessage(caller, {}, { url: channelPermalink, maxPages: 1 });

    expect(result.contextSource).toBe("replies");
    expect(result.complete).toBe(false);
    expect(result.context.map((message) => message.text)).toEqual(["root", "exact reply"]);
    expect(result.pagesFetched).toBe(2);
    expect(caller.callTool.mock.calls.map((call) => call[0])).toEqual([
      "conversations_search_messages",
      "conversations_replies",
    ]);
  });

  it("uses inclusive conversations.history for an unthreaded DM, never replies", async () => {
    const caller = callerFrom((name) => {
      if (name !== "conversations_search_messages") throw new Error(`unexpected tool: ${name}`);
      return {
        text: csv([{
          msg: "1775989800.123456",
          channel: "D123 (@colleague)",
          permalink: dmPermalink,
          text: "exact dm",
        }]),
        isError: false,
      };
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        messages: [
          { ts: "1775989801.000000", user: "U2", text: "answer" },
          { ts: "1775989800.123456", user: "UME", text: "exact dm" },
        ],
        response_metadata: { next_cursor: "" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runOpenMessage(caller, {}, {
      permalink: dmPermalink,
      oldest: "1775989700.000000",
      latest: "1775989900.000000",
    });

    expect(result.contextSource).toBe("history");
    expect(result.conversationType).toBe("dm");
    expect(result.complete).toBe(true);
    expect(caller.callTool).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.pathname).toBe("/api/conversations.history");
    expect(Object.fromEntries(requestUrl.searchParams)).toMatchObject({
      channel: "D123",
      oldest: "1775989700.000000",
      latest: "1775989900.000000",
      inclusive: "true",
    });
  });

  it("returns a partial exact result when Web API context auth fails", async () => {
    identityMocks.resolveSlackToken.mockReturnValueOnce(null);
    const caller = callerFrom(() => ({
      text: csv([{
        msg: "1775989800.123456",
        channel: "D123 (@colleague)",
        permalink: dmPermalink,
        text: "exact dm",
      }]),
      isError: false,
    }));

    const result = await runOpenMessage(caller, {}, { permalink: dmPermalink });

    expect(result.exactMessage.text).toBe("exact dm");
    expect(result.context).toHaveLength(1);
    expect(result.contextSource).toBe("search-only");
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toContain("returning the exact search result only");
  });
});

describe("runThreadsGetMany", () => {
  it("keeps per-item success/error/completeness and remains DM-aware", async () => {
    const dmPermalink = "https://example.slack.com/archives/D123/p1775989800123456";
    const caller = callerFrom((name) => {
      if (name !== "conversations_search_messages") throw new Error("DM batch must not call replies");
      return {
        text: csv([{
          msg: "1775989800.123456",
          channel: "D123 (@colleague)",
          permalink: dmPermalink,
          text: "exact dm",
        }]),
        isError: false,
      };
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, messages: [], response_metadata: { next_cursor: "" } }),
    }));

    const result = await runThreadsGetMany(caller, {}, {
      refs: [dmPermalink, "not a permalink"],
      concurrency: 2,
    });

    expect(result.itemCount).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.results[0]).toMatchObject({ complete: true });
    expect(result.results[1]).toMatchObject({ complete: false, pagesFetched: 0 });
    expect(result.results[1]).toHaveProperty("error");
    expect(caller.callTool).toHaveBeenCalledTimes(1);
  });
});
