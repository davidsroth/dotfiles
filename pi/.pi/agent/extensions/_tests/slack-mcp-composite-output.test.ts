import { describe, expect, it } from "vitest";
import { formatCompositeResult } from "../slack-mcp/composite-output";

describe("formatCompositeResult", () => {
  it("wraps complete data in a versioned stable envelope", () => {
    const result = formatCompositeResult("slack_test", { complete: true, messages: [{ text: "ok" }] }, 5_000);
    expect(JSON.parse(result.text)).toEqual(result.envelope);
    expect(result.envelope.schema_version).toBe("slack-wrapper/v1");
    expect(result.envelope.meta.complete).toBe(true);
    expect(result.envelope.meta.response_complete).toBe(true);
  });

  it("trims on array boundaries, remains valid JSON, and reports omissions", () => {
    const data = {
      complete: true,
      messages: Array.from({ length: 100 }, (_, i) => ({ id: i, text: "x".repeat(400) })),
    };
    const result = formatCompositeResult("slack_test", data, 4_000);
    const parsed = JSON.parse(result.text);
    expect(result.text.length).toBeLessThanOrEqual(4_000);
    expect(parsed.meta.response_complete).toBe(false);
    expect(parsed.meta.complete).toBe(false);
    expect(parsed.meta.omissions[0].path).toBe("data.messages");
    expect(parsed.data.messages.length).toBeLessThan(100);
  });

  it("keeps retrieval and response completeness distinct", () => {
    const result = formatCompositeResult("slack_test", { complete: false, warnings: ["page cap"] }, 5_000);
    expect(result.envelope.meta.retrieval_complete).toBe(false);
    expect(result.envelope.meta.response_complete).toBe(true);
    expect(result.envelope.meta.complete).toBe(false);
  });

  it("rejects unusably small budgets rather than cutting JSON bytes", () => {
    expect(() => formatCompositeResult("slack_test", {}, 999)).toThrow(/at least 1000/);
  });
});
