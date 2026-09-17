import { beforeEach, describe, expect, it, vi } from "vitest";

const identityMocks = vi.hoisted(() => ({ resolveSlackToken: vi.fn() }));
vi.mock("../slack-mcp/identity", () => identityMocks);

import { callSlackWebApi, fetchConversationHistory, type SlackFetch } from "../slack-mcp/slack-api";

beforeEach(() => {
  vi.clearAllMocks();
  identityMocks.resolveSlackToken.mockReturnValue({ token: "test-token", cookie: "d=test-cookie" });
});

describe("callSlackWebApi", () => {
  it("only permits read-only methods and forwards browser auth without exposing it in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: 1 }),
    });

    await callSlackWebApi({}, "users.info", { user: "U1" }, fetchMock as SlackFetch);

    const [rawUrl, init] = fetchMock.mock.calls[0];
    const url = new URL(String(rawUrl));
    expect(url.searchParams.get("user")).toBe("U1");
    expect(String(rawUrl)).not.toContain("test-token");
    expect(init).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer test-token", Cookie: "d=test-cookie" },
    });
    await expect(callSlackWebApi({}, "chat.postMessage", {}, fetchMock as SlackFetch)).rejects.toThrow("not allowlisted");
  });

  it("treats Slack ok:false as an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: "missing_scope" }),
    });
    await expect(callSlackWebApi({}, "conversations.history", {}, fetchMock as SlackFetch)).rejects.toThrow("missing_scope");
  });
});

describe("fetchConversationHistory", () => {
  it("keeps exact parameters on cursor pages, filters inclusive boundaries, and removes duplicates", async () => {
    const responses = [
      {
        ok: true,
        messages: [
          { ts: "10.000000", text: "oldest" },
          { ts: "15.000000", text: "middle" },
          { ts: "9.999999", text: "outside" },
        ],
        response_metadata: { next_cursor: "next" },
      },
      {
        ok: true,
        messages: [
          { ts: "15.000000", text: "duplicate" },
          { ts: "20.000000", text: "latest" },
          { ts: "20.000001", text: "outside" },
        ],
        response_metadata: { next_cursor: "" },
      },
    ];
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => responses.shift(),
    }));

    const result = await fetchConversationHistory({}, {
      channelId: "D1",
      oldest: "10.000000",
      latest: "20.000000",
      inclusive: true,
      maxPages: 5,
    }, fetchMock as SlackFetch);

    expect(result.messages.map((message) => message.ts)).toEqual(["10.000000", "15.000000", "20.000000"]);
    expect(result.pagesFetched).toBe(2);
    expect(result.complete).toBe(true);

    const first = new URL(String(fetchMock.mock.calls[0][0]));
    const second = new URL(String(fetchMock.mock.calls[1][0]));
    for (const url of [first, second]) {
      expect(url.searchParams.get("channel")).toBe("D1");
      expect(url.searchParams.get("oldest")).toBe("10.000000");
      expect(url.searchParams.get("latest")).toBe("20.000000");
      expect(url.searchParams.get("inclusive")).toBe("true");
    }
    expect(first.searchParams.get("cursor")).toBeNull();
    expect(second.searchParams.get("cursor")).toBe("next");
  });

  it("preserves the remaining cursor and marks a max-page result incomplete", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        messages: [{ ts: "15.000000", text: "middle" }],
        response_metadata: { next_cursor: "still-more" },
      }),
    });

    const result = await fetchConversationHistory({}, {
      channelId: "D1",
      oldest: "10.000000",
      latest: "20.000000",
      maxPages: 1,
    }, fetchMock as SlackFetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(false);
    expect(result.nextCursor).toBe("still-more");
    expect(result.warnings.join(" ")).toContain("maxPages=1");
  });
});
