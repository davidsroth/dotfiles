/**
 * Tests for slack-mcp postprocess.ts and identity.ts.
 *
 * Hermetic: no real network, no real child processes, no reads of user config.
 * All fetch calls are intercepted via vi.stubGlobal.
 * Module-level caches (userNameCache, identityCache) are cleared in beforeEach.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Mock identity.ts so postprocess.ts never makes real network calls.
// We intercept only fetchUserName; resolveSlackToken stays real inside the mock
// by spreading the actual module.
// ---------------------------------------------------------------------------
vi.mock("../slack-mcp/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../slack-mcp/identity")>();
  return {
    ...actual,
    fetchUserName: vi.fn().mockResolvedValue(null),
  };
});

// Import postprocess symbols (uses the mocked identity module).
import {
  augmentSchemaWithControls,
  parseCSV,
  postProcessCsv,
  resolveMentions,
  userNameCache,
} from "../slack-mcp/postprocess";

// Import the mocked identity symbols (fetchUserName is vi.fn here).
import {
  fetchUserName as mockedFetchUserName,
} from "../slack-mcp/identity";

// Import identity symbols that we test directly; use importActual so these
// bypass the vi.mock and always run the real code.
const identityActual = await vi.importActual<typeof import("../slack-mcp/identity")>(
  "../slack-mcp/identity",
);

// identityCache is the real module-level Map (exported by the refactor).
// We need the actual cache, not a proxy through the mock.
import { identityCache } from "../slack-mcp/identity";

import type { ResolvedPostProcess } from "../slack-mcp/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockFetchUserName = mockedFetchUserName as ReturnType<typeof vi.fn>;

function pp(over: Partial<ResolvedPostProcess> = {}): ResolvedPostProcess {
  return {
    enabled: true,
    dropColumns: new Set<string>(),
    maxTextLength: 0,
    resolveMentions: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// beforeEach: reset caches + mock state
// ---------------------------------------------------------------------------

beforeEach(() => {
  userNameCache.clear();
  identityCache.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// =============================================================================
// parseCSV
// =============================================================================

describe("parseCSV", () => {
  // --- parseCSV-basic-rows ---------------------------------------------------
  describe("basic rows", () => {
    it("splits two-column two-row CSV with trailing newline", () => {
      expect(parseCSV("a,b\nc,d\n")).toEqual([["a", "b"], ["c", "d"]]);
    });

    it("splits two-column two-row CSV without trailing newline (partial-row flush)", () => {
      expect(parseCSV("a,b\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
    });
  });

  // --- parseCSV-quoted-field-with-comma -------------------------------------
  describe("quoted field with embedded comma", () => {
    it("does not split on comma inside double quotes", () => {
      const rows = parseCSV('a,"b,c"\n');
      expect(rows).not.toBeNull();
      expect(rows![0][1]).toBe("b,c");
    });

    it("handles multi-column with leading quoted field", () => {
      expect(parseCSV('"hello,world",foo\n')).toEqual([["hello,world", "foo"]]);
    });
  });

  // --- parseCSV-quoted-field-with-embedded-newline --------------------------
  describe("quoted field with embedded newline", () => {
    it("treats newline inside quotes as part of the field, not a row terminator", () => {
      const rows = parseCSV('"line1\nline2",x\n');
      expect(rows).not.toBeNull();
      expect(rows!.length).toBe(1);
      expect(rows![0][0]).toBe("line1\nline2");
      expect(rows![0][1]).toBe("x");
    });
  });

  // --- parseCSV-rfc4180-escaped-quote ----------------------------------------
  describe("RFC4180 doubled-quote escape", () => {
    it('turns "" inside a quoted field into a single "', () => {
      const rows = parseCSV('"say ""hi"""\n');
      expect(rows).not.toBeNull();
      expect(rows![0][0]).toBe('say "hi"');
    });
  });

  // --- parseCSV-unterminated-quote-returns-null ------------------------------
  describe("unterminated quote returns null", () => {
    it("returns null for input with unclosed quote", () => {
      expect(parseCSV('"unclosed field')).toBeNull();
    });
  });

  // --- parseCSV-empty-and-whitespace-only ------------------------------------
  describe("empty / whitespace input", () => {
    it("returns null for empty string", () => {
      expect(parseCSV("")).toBeNull();
    });

    it("returns null for only \\r chars (sawAny stays false)", () => {
      expect(parseCSV("\r\r\r")).toBeNull();
    });

    it("\\r\\n-only: LF triggers row push making sawAny true, returns [['']]", () => {
      const rows = parseCSV("\r\n");
      expect(rows).not.toBeNull();
      expect(rows).toEqual([[""]]);
    });
  });

  // --- parseCSV-crlf-stripping -----------------------------------------------
  describe("CRLF stripping", () => {
    it("produces the same result as LF-only input", () => {
      expect(parseCSV("a,b\r\nc,d\r\n")).toEqual(parseCSV("a,b\nc,d\n"));
    });
  });
});

// =============================================================================
// postProcessCsv
// =============================================================================

describe("postProcessCsv", () => {
  // --- postProcessCsv-passthrough-disabled -----------------------------------
  describe("passthrough when disabled", () => {
    it("returns original text when pp.enabled is false", async () => {
      const text = "some,csv\nrow,data\n";
      const result = await postProcessCsv(text, pp({ enabled: false }), {});
      expect(result).toBe(text);
    });

    it("returns '' when text is empty", async () => {
      const result = await postProcessCsv("", pp(), {});
      expect(result).toBe("");
    });
  });

  // --- postProcessCsv-passthrough-malformed ----------------------------------
  describe("passthrough for malformed / degenerate CSV", () => {
    it("returns original when parseCSV returns null (unterminated quote)", async () => {
      const text = '"unclosed field';
      const result = await postProcessCsv(text, pp(), {});
      expect(result).toBe(text);
    });

    it("returns original when CSV has only one row (header only, no data)", async () => {
      const text = "Header1,Header2\n";
      const result = await postProcessCsv(text, pp(), {});
      expect(result).toBe(text);
    });

    it("returns original when CSV rows are ragged (different column counts)", async () => {
      const text = "A,B,C\n1,2\n";
      const result = await postProcessCsv(text, pp(), {});
      expect(result).toBe(text);
    });
  });

  // --- postProcessCsv-no-change-returns-original-bytes ----------------------
  describe("returns original string reference when nothing changes", () => {
    it("returns the exact same string when no transforms are applied", async () => {
      const text = "Timestamp,Text\n2024-01-01,hello\n";
      const result = await postProcessCsv(
        text,
        pp({ dropColumns: new Set(), resolveMentions: false, maxTextLength: 0 }),
        {},
      );
      expect(result).toBe(text);
    });
  });

  // --- postProcessCsv-drop-columns -------------------------------------------
  describe("drop columns", () => {
    it("removes a dropped column from header and all data rows", async () => {
      // Use a column name that does NOT trigger cursor-footer logic (non-Cursor col)
      const text = "Timestamp,Text,Extra\n2024-01-01,hello,unused\n";
      const result = await postProcessCsv(
        text,
        pp({ dropColumns: new Set(["Extra"]) }),
        {},
      );
      expect(result).toBe("Timestamp,Text\n2024-01-01,hello\n");
    });

    it("drops Cursor column and leaves other columns intact", async () => {
      // When Cursor column IS dropped and cursor value is empty, no footer added
      const text = "Timestamp,Text,Cursor\n2024-01-01,hello,\n";
      const result = await postProcessCsv(
        text,
        pp({ dropColumns: new Set(["Cursor"]) }),
        {},
      );
      expect(result).toBe("Timestamp,Text\n2024-01-01,hello\n");
    });
  });

  // --- postProcessCsv-cursor-footer-when-cursor-dropped ----------------------
  describe("cursor footer when Cursor column is dropped", () => {
    it("appends next_cursor footer with last non-empty cursor value", async () => {
      const text = "Timestamp,Cursor\nrow1,page2tok\nrow2,\n";
      const result = await postProcessCsv(
        text,
        pp({ dropColumns: new Set(["Cursor"]) }),
        {},
      );
      // Should contain the data rows without Cursor and then the footer
      expect(result).toContain("next_cursor: page2tok\n");
      expect(result).not.toContain(",Cursor");
    });

    it("does NOT append footer when all cursor cells are empty", async () => {
      const text = "Timestamp,Cursor\nrow1,\nrow2,\n";
      const result = await postProcessCsv(
        text,
        pp({ dropColumns: new Set(["Cursor"]) }),
        {},
      );
      expect(result).not.toContain("next_cursor:");
    });

    it("does NOT append footer when Cursor column exists but is not in dropColumns", async () => {
      const text = "Timestamp,Cursor\nrow1,page2tok\n";
      // Not dropping Cursor => no footer, cursor stays in output
      const result = await postProcessCsv(text, pp(), {});
      // No transforms => passthrough (changed stays false)
      expect(result).toBe(text);
    });

    it("does NOT append footer when another column is dropped but Cursor is kept", async () => {
      // Re-serialization happens (Topic dropped => changed=true), but the
      // footer is gated on Cursor itself being dropped, not on any drop.
      const text = "Timestamp,Topic,Cursor\nrow1,t,page2tok\n";
      const result = await postProcessCsv(text, pp({ dropColumns: new Set(["Topic"]) }), {});
      expect(result).not.toContain("next_cursor:");
      expect(result).toContain("page2tok");
      expect(result).not.toContain("Topic");
    });
  });

  // --- postProcessCsv-text-truncation ----------------------------------------
  describe("text truncation", () => {
    it("truncates Text column and appends ellipsis + count", async () => {
      // Need >= 2 columns so the CSV passes the header.length < 2 guard
      const longText = "A".repeat(2010);
      const text = `Timestamp,Text\n2024-01-01,${longText}\n`;
      const result = await postProcessCsv(
        text,
        pp({ maxTextLength: 2000 }),
        {},
      );
      expect(result).toContain("A".repeat(2000) + "…[+10 chars truncated]");
    });

    it("does not truncate when text is exactly at the limit", async () => {
      const exactText = "B".repeat(2000);
      const text = `Timestamp,Text\n2024-01-01,${exactText}\n`;
      const result = await postProcessCsv(text, pp({ maxTextLength: 2000 }), {});
      expect(result).not.toContain("truncated");
    });
  });

  // --- postProcessCsv-text-no-truncation-when-zero ---------------------------
  describe("no truncation when maxTextLength is 0", () => {
    it("keeps full text when maxTextLength === 0", async () => {
      const longText = "B".repeat(5000);
      // Single column would fail header.length < 2 guard, so use two columns
      // but neither triggers any transform => passthrough
      const text = `Timestamp,ExtraCol\n2024-01-01,value\n`;
      const result = await postProcessCsv(text, pp({ maxTextLength: 0 }), {});
      // No transforms applied => unchanged
      expect(result).toBe(text);
    });

    it("keeps long text unchanged in Text column when maxTextLength === 0", async () => {
      const longText = "B".repeat(5000);
      // resolveMentions: false, maxTextLength: 0 means no text transform
      // but we need a non-Text column change to trigger re-serialization to test
      // Instead, verify via direct observation: the original text is returned
      const text = `Timestamp,Text\n2024-01-01,${longText}\n`;
      const result = await postProcessCsv(text, pp({ maxTextLength: 0 }), {});
      expect(result).toBe(text);
    });
  });

  // --- serializeCSV quoting rules (tested indirectly) ----------------------
  describe("serializeCSV quoting rules (indirect round-trips)", () => {
    it("re-quotes a Text field containing a comma after column drop", async () => {
      // Drop a column so re-serialization occurs, with a comma in the Text field
      const text = 'Text,Extra\n"hello,world",drop-me\n';
      const result = await postProcessCsv(
        text,
        pp({ dropColumns: new Set(["Extra"]) }),
        {},
      );
      // The comma-containing field must be quoted in output
      expect(result).toContain('"hello,world"');
    });

    it("escapes double-quotes in Text field on re-serialization", async () => {
      // Field value after parsing is: say "hi"
      const text = 'Text,Extra\n"say ""hi""",drop-me\n';
      const result = await postProcessCsv(
        text,
        pp({ dropColumns: new Set(["Extra"]) }),
        {},
      );
      // After round-trip: field is 'say "hi"', serialized as "say ""hi"""
      expect(result).toContain('"say ""hi"""');
    });
  });

  // --- augmentSchemaWithControls-adds-fields ---------------------------------
  describe("augmentSchemaWithControls adds fields", () => {
    it("adds _maxTextLength and _raw to MESSAGE_TEXT_TOOLS schema when enabled", () => {
      const schema = { type: "object", properties: { channel: { type: "string" } } };
      const result = augmentSchemaWithControls(schema, "conversations_history", pp({ enabled: true }));
      const props = result.properties as Record<string, unknown>;
      expect(props).toHaveProperty("_maxTextLength");
      expect(props).toHaveProperty("_raw");
      expect(props).toHaveProperty("channel");
      // Must be a new object
      expect(result).not.toBe(schema);
    });

    it("preserves original properties alongside new control fields", () => {
      const schema = { type: "object", properties: { text: { type: "string" } } };
      const result = augmentSchemaWithControls(schema, "conversations_search_messages", pp());
      const props = result.properties as Record<string, unknown>;
      expect(props).toHaveProperty("text");
    });
  });

  // --- augmentSchemaWithControls-skips-non-text-tools -----------------------
  describe("augmentSchemaWithControls skips non-text tools", () => {
    it("returns the original schema unchanged for channels_list", () => {
      const schema = { type: "object", properties: { limit: { type: "number" } } };
      const result = augmentSchemaWithControls(schema, "channels_list", pp());
      expect(result).toBe(schema);
    });
  });

  // --- augmentSchemaWithControls-skips-when-disabled ------------------------
  describe("augmentSchemaWithControls skips when disabled", () => {
    it("returns original schema when pp.enabled is false", () => {
      const schema = { type: "object", properties: {} };
      const result = augmentSchemaWithControls(schema, "conversations_history", pp({ enabled: false }));
      expect(result).toBe(schema);
    });
  });
});

// =============================================================================
// resolveMentions (exported for direct testing)
// =============================================================================

describe("resolveMentions", () => {
  // --- resolveMentions-inline-name-form --------------------------------------
  describe("inline-name form <@U123|displayname>", () => {
    it("replaces inline-name user mention with @name without any fetch", async () => {
      const out = await resolveMentions("<@U12345|alice>", {}, { n: 25 });
      expect(out).toBe("@alice");
      expect(mockFetchUserName).not.toHaveBeenCalled();
    });

    it("seeds userNameCache from inline form so subsequent bare mention is a cache hit", async () => {
      // First call populates cache
      await resolveMentions("<@U12345|alice>", {}, { n: 25 });
      mockFetchUserName.mockClear();

      // Second call with bare mention should resolve from cache, NOT call fetchUserName
      const out = await resolveMentions("<@U12345>", {}, { n: 25 });
      expect(out).toBe("@alice");
      expect(mockFetchUserName).not.toHaveBeenCalled();
    });
  });

  // --- resolveMentions-bare-mention-lookup -----------------------------------
  describe("bare mention <@U…> network lookup", () => {
    it("calls fetchUserName and replaces token when name returned", async () => {
      mockFetchUserName.mockResolvedValueOnce("bob");
      const out = await resolveMentions("<@U99999>", { SLACK_MCP_XOXP_TOKEN: "tok" }, { n: 25 });
      expect(out).toBe("@bob");
      expect(mockFetchUserName).toHaveBeenCalledWith("U99999", { SLACK_MCP_XOXP_TOKEN: "tok" });
    });

    it("keeps original token verbatim when fetchUserName returns null", async () => {
      mockFetchUserName.mockResolvedValueOnce(null);
      const out = await resolveMentions("<@U99999>", {}, { n: 25 });
      expect(out).toBe("<@U99999>");
    });
  });

  // --- resolveMentions-budget-cap --------------------------------------------
  describe("budget cap (MENTION_LOOKUP_CAP = 25)", () => {
    it("stops calling fetchUserName after 25 lookups and leaves the 26th mention raw", async () => {
      mockFetchUserName.mockResolvedValue("user");

      // Build a string with 26 unique bare user mentions
      const mentions = Array.from({ length: 26 }, (_, i) => {
        const idNum = String(i + 1).padStart(5, "0");
        return `<@U${idNum}>`;
      });
      const text = mentions.join(" ");

      const out = await resolveMentions(text, {}, { n: 25 });

      expect(mockFetchUserName).toHaveBeenCalledTimes(25);

      // The 26th id (U00026) was not looked up; it stays raw if not in cache
      // (Set iteration order is insertion order, last added = U00026)
      const rawId = "U00026";
      expect(out).toContain(`<@${rawId}>`);
    });
  });

  // --- resolveMentions-channel-mention ---------------------------------------
  describe("channel mention <#C123|name>", () => {
    it("replaces channel mention with #name without any fetch", async () => {
      const out = await resolveMentions("<#C12345|general>", {}, { n: 25 });
      expect(out).toBe("#general");
      expect(mockFetchUserName).not.toHaveBeenCalled();
    });
  });

  // --- resolveMentions-regex-does-not-match-wrong-prefix --------------------
  describe("regex does not match non-U/W prefixed IDs", () => {
    it("leaves bot id <@B…> token unchanged and does not call fetchUserName", async () => {
      const out = await resolveMentions("<@B12345>", {}, { n: 25 });
      expect(out).toBe("<@B12345>");
      expect(mockFetchUserName).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// postProcessCsv mention resolution (via full pipeline)
// =============================================================================

describe("postProcessCsv mention resolution", () => {
  it("resolves inline-name mention in Text column", async () => {
    // Need 2+ columns to pass header.length check
    const text = "Timestamp,Text\n2024-01-01,<@U12345|alice>\n";
    const result = await postProcessCsv(text, pp({ resolveMentions: true }), {});
    expect(result).toContain("@alice");
  });

  it("resolves bare mention via fetchUserName mock", async () => {
    mockFetchUserName.mockResolvedValueOnce("bob");
    const text = "Timestamp,Text\n2024-01-01,<@U99999>\n";
    const result = await postProcessCsv(
      text,
      pp({ resolveMentions: true }),
      { SLACK_MCP_XOXP_TOKEN: "tok" },
    );
    expect(result).toContain("@bob");
  });
});

// =============================================================================
// identity.ts — resolveSlackToken (using real implementation via importActual)
// =============================================================================

describe("resolveSlackToken", () => {
  const { resolveSlackToken } = identityActual;

  const savedEnv: Record<string, string | undefined> = {};
  const SLACK_KEYS = [
    "SLACK_MCP_XOXP_TOKEN",
    "SLACK_MCP_XOXB_TOKEN",
    "SLACK_MCP_XOXC_TOKEN",
    "SLACK_MCP_XOXD_TOKEN",
  ] as const;

  beforeEach(() => {
    for (const key of SLACK_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SLACK_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  // --- resolveSlackToken-priority-order --------------------------------------
  describe("priority order", () => {
    it("returns xoxp token from env param", () => {
      const r = resolveSlackToken({ SLACK_MCP_XOXP_TOKEN: "xoxp-tok" });
      expect(r).toEqual({ token: "xoxp-tok" });
    });

    it("returns xoxb token when only xoxb is present", () => {
      const r = resolveSlackToken({ SLACK_MCP_XOXB_TOKEN: "xoxb-tok" });
      expect(r).toEqual({ token: "xoxb-tok" });
    });

    it("prefers xoxp over xoxb when both present", () => {
      const r = resolveSlackToken({
        SLACK_MCP_XOXP_TOKEN: "xoxp-tok",
        SLACK_MCP_XOXB_TOKEN: "xoxb-tok",
      });
      expect(r).toEqual({ token: "xoxp-tok" });
    });

    it("returns xoxc + xoxd as browser token with cookie", () => {
      const r = resolveSlackToken({
        SLACK_MCP_XOXC_TOKEN: "xoxc-tok",
        SLACK_MCP_XOXD_TOKEN: "xoxd-val",
      });
      expect(r).toEqual({ token: "xoxc-tok", cookie: "d=xoxd-val" });
    });

    it("returns null when all tokens absent from env param and process.env", () => {
      const r = resolveSlackToken({});
      expect(r).toBeNull();
    });

    it("falls back to process.env.SLACK_MCP_XOXP_TOKEN when env param is empty", () => {
      process.env.SLACK_MCP_XOXP_TOKEN = "xoxp-from-env";
      const r = resolveSlackToken({});
      expect(r).toEqual({ token: "xoxp-from-env" });
    });
  });

  // --- resolveSlackToken-xoxc-requires-both ----------------------------------
  describe("xoxc requires both xoxc and xoxd", () => {
    it("returns null when only xoxc present (no xoxd)", () => {
      expect(resolveSlackToken({ SLACK_MCP_XOXC_TOKEN: "xoxc-tok" })).toBeNull();
    });

    it("returns null when only xoxd present (no xoxc)", () => {
      expect(resolveSlackToken({ SLACK_MCP_XOXD_TOKEN: "xoxd-val" })).toBeNull();
    });

    it("returns non-null with cookie field when both xoxc and xoxd present", () => {
      const r = resolveSlackToken({
        SLACK_MCP_XOXC_TOKEN: "xoxc-tok",
        SLACK_MCP_XOXD_TOKEN: "xoxd-val",
      });
      expect(r).not.toBeNull();
      expect(r!.cookie).toBe("d=xoxd-val");
    });
  });
});

// =============================================================================
// identity.ts — slackAuthTest (using real implementation via importActual)
// =============================================================================

describe("slackAuthTest", () => {
  const { slackAuthTest } = identityActual;

  const SLACK_KEYS = [
    "SLACK_MCP_XOXP_TOKEN",
    "SLACK_MCP_XOXB_TOKEN",
    "SLACK_MCP_XOXC_TOKEN",
    "SLACK_MCP_XOXD_TOKEN",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    identityCache.clear();
    for (const key of SLACK_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    for (const key of SLACK_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]!;
      } else {
        delete process.env[key];
      }
    }
    vi.unstubAllGlobals();
  });

  // --- slackAuthTest-no-token-returns-no-token-error -------------------------
  describe("no token", () => {
    it("returns {ok:false, error:'no_token'} without calling fetch", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await slackAuthTest({});
      expect(result).toEqual({ ok: false, error: "no_token" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // --- slackAuthTest-caches-on-ok-true ----------------------------------------
  describe("caches on ok:true", () => {
    it("calls fetch only once for the same token across two calls", async () => {
      const identity = {
        ok: true,
        url: "https://x.slack.com/",
        user: "alice",
        user_id: "U1",
        team: "T1",
        team_id: "T0",
      };
      const fetchMock = vi.fn().mockResolvedValue({ json: async () => identity });
      vi.stubGlobal("fetch", fetchMock);

      const r1 = await slackAuthTest({ SLACK_MCP_XOXP_TOKEN: "xoxp-tok" });
      const r2 = await slackAuthTest({ SLACK_MCP_XOXP_TOKEN: "xoxp-tok" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(identity);
      expect(r2).toEqual(identity);
    });
  });

  // --- slackAuthTest-no-cache-on-ok-false -------------------------------------
  describe("does not cache on ok:false", () => {
    it("retries fetch on second call after first call returned ok:false", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ json: async () => ({ ok: false, error: "invalid_auth" }) })
        .mockResolvedValueOnce({ json: async () => ({ ok: true, user_id: "U1" }) });
      vi.stubGlobal("fetch", fetchMock);

      const r1 = await slackAuthTest({ SLACK_MCP_XOXP_TOKEN: "xoxp-tok" });
      const r2 = await slackAuthTest({ SLACK_MCP_XOXP_TOKEN: "xoxp-tok" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(r1.ok).toBe(false);
      expect(r2.ok).toBe(true);
    });
  });

  // --- slackAuthTest-xoxc-cookie-header ----------------------------------------
  describe("cookie header for xoxc token", () => {
    it("sends both Authorization and Cookie headers for browser tokens", async () => {
      let capturedHeaders: Record<string, string> | undefined;
      const fetchMock = vi.fn().mockImplementation(
        async (_url: string, opts: { headers: Record<string, string> }) => {
          capturedHeaders = opts.headers;
          return { json: async () => ({ ok: true, user_id: "U1" }) };
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      await slackAuthTest({
        SLACK_MCP_XOXC_TOKEN: "xoxc-tok",
        SLACK_MCP_XOXD_TOKEN: "my-cookie-val",
      });

      expect(capturedHeaders?.Authorization).toBe("Bearer xoxc-tok");
      expect(capturedHeaders?.Cookie).toBe("d=my-cookie-val");
    });
  });

  // --- slackAuthTest-fetch-exception-returns-error-object -------------------
  describe("fetch exception handling", () => {
    it("returns {ok:false, error: message} when fetch throws an Error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network timeout")));
      const result = await slackAuthTest({ SLACK_MCP_XOXP_TOKEN: "xoxp-tok" });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("network timeout");
    });

    it("returns {ok:false, error: string} when fetch throws a non-Error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue("string error"));
      const result = await slackAuthTest({ SLACK_MCP_XOXP_TOKEN: "xoxp-tok" });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("string error");
    });
  });

  // --- identityCache-keyed-by-token ------------------------------------------
  describe("identityCache keyed by token", () => {
    it("caches two different tokens independently", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ json: async () => ({ ok: true, user_id: "U1" }) })
        .mockResolvedValueOnce({ json: async () => ({ ok: true, user_id: "U2" }) });
      vi.stubGlobal("fetch", fetchMock);

      const r1 = await slackAuthTest({ SLACK_MCP_XOXP_TOKEN: "tok-A" });
      const r2 = await slackAuthTest({ SLACK_MCP_XOXP_TOKEN: "tok-B" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(r1.user_id).toBe("U1");
      expect(r2.user_id).toBe("U2");
    });
  });
});

// =============================================================================
// identity.ts — fetchUserName (using real implementation via importActual)
// =============================================================================

describe("fetchUserName", () => {
  const { fetchUserName } = identityActual;

  const SLACK_KEYS = [
    "SLACK_MCP_XOXP_TOKEN",
    "SLACK_MCP_XOXB_TOKEN",
    "SLACK_MCP_XOXC_TOKEN",
    "SLACK_MCP_XOXD_TOKEN",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SLACK_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    for (const key of SLACK_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]!;
      } else {
        delete process.env[key];
      }
    }
    vi.unstubAllGlobals();
  });

  // --- fetchUserName-display-name-priority -----------------------------------
  describe("display name priority", () => {
    it("returns display_name when all three name fields are set", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          json: async () => ({
            ok: true,
            user: { name: "login", profile: { display_name: "Display", real_name: "Real" } },
          }),
        }),
      );
      const name = await fetchUserName("U1", { SLACK_MCP_XOXP_TOKEN: "tok" });
      expect(name).toBe("Display");
    });

    it("returns real_name when display_name is empty string", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          json: async () => ({
            ok: true,
            user: { name: "login", profile: { display_name: "", real_name: "Real" } },
          }),
        }),
      );
      const name = await fetchUserName("U1", { SLACK_MCP_XOXP_TOKEN: "tok" });
      expect(name).toBe("Real");
    });

    it("returns name (login handle) when only name is set", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          json: async () => ({
            ok: true,
            user: { name: "login-handle", profile: {} },
          }),
        }),
      );
      const name = await fetchUserName("U1", { SLACK_MCP_XOXP_TOKEN: "tok" });
      expect(name).toBe("login-handle");
    });

    it("returns null when data.ok is false", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          json: async () => ({ ok: false, error: "user_not_found" }),
        }),
      );
      const name = await fetchUserName("U1", { SLACK_MCP_XOXP_TOKEN: "tok" });
      expect(name).toBeNull();
    });
  });

  // --- fetchUserName-encodes-userId-in-url -----------------------------------
  describe("URL encoding", () => {
    it("includes ?user=U12345 in the fetch URL", async () => {
      let capturedUrl = "";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) => {
          capturedUrl = url;
          return { json: async () => ({ ok: true, user: { name: "alice" } }) };
        }),
      );
      await fetchUserName("U12345", { SLACK_MCP_XOXP_TOKEN: "tok" });
      expect(capturedUrl).toContain("?user=U12345");
    });
  });

  // --- returns null when no token configured --------------------------------
  describe("returns null when no token is configured", () => {
    it("returns null immediately without calling fetch when creds resolve to null", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const name = await fetchUserName("U1", {});
      expect(name).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
