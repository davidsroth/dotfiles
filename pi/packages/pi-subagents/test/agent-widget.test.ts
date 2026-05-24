import { describe, expect, it } from "vitest";
import { formatMs, formatSessionTokens } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  it("returns plain text with percent annotation", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (50%)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (70%)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (84%)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (85%)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (99%)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (↻1)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (↻3)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (45% · ↻2)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (88% · ↻4)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (45%)");
  });
});

describe("formatMs", () => {
  it("formats sub-minute durations as whole seconds", () => {
    expect(formatMs(0)).toBe("0s");
    expect(formatMs(999)).toBe("0s");
    expect(formatMs(42_500)).toBe("42s");
  });

  it("formats minutes and hours compactly", () => {
    expect(formatMs(5 * 60_000 + 30_000)).toBe("5m30s");
    expect(formatMs(60 * 60_000 + 2 * 60_000 + 3_000)).toBe("1h2m3s");
  });

  it("clamps negative durations to zero", () => {
    expect(formatMs(-1_000)).toBe("0s");
  });
});
