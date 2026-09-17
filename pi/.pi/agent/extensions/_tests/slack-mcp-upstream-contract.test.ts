import { describe, expect, it } from "vitest";
import { normalizeUpstreamArgs, patchUpstreamSchema } from "../slack-mcp/upstream-contract";

describe("patchUpstreamSchema", () => {
  it("corrects the DM filter contract for pinned upstream 1.3.0", () => {
    const schema = {
      type: "object",
      properties: {
        filter_in_im_or_mpim: { type: "string", description: "Accepts D ids" },
      },
    };
    const patched = patchUpstreamSchema(schema, "conversations_search_messages");
    const prop = (patched.properties as Record<string, Record<string, unknown>>).filter_in_im_or_mpim;
    expect(prop.description).toContain("user ID");
    expect(prop.description).toContain("does NOT accept a D");
    expect(prop.type).toBe("string");
  });

  it("marks Slack search date fields as day-level", () => {
    const schema = {
      type: "object",
      properties: { filter_date_after: { type: "string", description: "After a date." } },
    };
    const patched = patchUpstreamSchema(schema, "conversations_search_messages");
    const prop = (patched.properties as Record<string, Record<string, unknown>>).filter_date_after;
    expect(prop.description).toContain("day-level");
  });

  it("allows integer or duration history limits and documents exact-range alternatives", () => {
    const schema = {
      type: "object",
      properties: { limit: { type: "string", description: "old" } },
    };
    const patched = patchUpstreamSchema(schema, "conversations_history");
    const prop = (patched.properties as Record<string, Record<string, unknown>>).limit;
    expect(prop.type).toEqual(["integer", "string"]);
    expect(prop.description).toContain("not a calendar date");
  });

  it("leaves unrelated tools unchanged", () => {
    const schema = { type: "object", properties: { limit: { type: "integer" } } };
    expect(patchUpstreamSchema(schema, "channels_list")).toBe(schema);
  });
});

describe("normalizeUpstreamArgs", () => {
  it("normalizes numeric history limits to the string expected upstream", () => {
    expect(normalizeUpstreamArgs("conversations_history", { limit: 25, channel_id: "C1" }))
      .toEqual({ ok: true, args: { limit: "25", channel_id: "C1" } });
  });

  it.each(["25", "1d", "2w", "3m"])("accepts valid limit %s", (limit) => {
    expect(normalizeUpstreamArgs("conversations_replies", { limit })).toEqual({ ok: true, args: { limit } });
  });

  it("rejects a calendar date with an actionable error", () => {
    const result = normalizeUpstreamArgs("conversations_history", { limit: "2026-09-03" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("calendar date");
  });

  it("does not modify unrelated tool arguments", () => {
    const args = { limit: 100 };
    expect(normalizeUpstreamArgs("conversations_search_messages", args)).toEqual({ ok: true, args });
  });
});
