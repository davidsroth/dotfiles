import { describe, expect, it } from "vitest";
import {
  findCharMotionTarget,
  findFirstNonWhitespaceColumn,
  findNextParagraphStart,
  findPrevParagraphStart,
  reverseCharMotion,
} from "../motions.js";

describe("motion helpers", () => {
  it("finds first non-whitespace and handles blank lines", () => {
    expect(findFirstNonWhitespaceColumn("   value")).toBe(3);
    expect(findFirstNonWhitespaceColumn("   ")).toBe(0);
  });

  it("finds paragraph boundaries in both directions", () => {
    const lines = ["first", "continuation", "", "second", "", "third"];
    expect(findNextParagraphStart(lines, 0)).toBe(3);
    expect(findNextParagraphStart(lines, 3)).toBe(5);
    expect(findPrevParagraphStart(lines, 5)).toBe(3);
    expect(findPrevParagraphStart(lines, 3)).toBe(0);
  });

  it("reverses character motions", () => {
    expect(reverseCharMotion("f")).toBe("F");
    expect(reverseCharMotion("t")).toBe("T");
    expect(reverseCharMotion("F")).toBe("f");
    expect(reverseCharMotion("T")).toBe("t");
  });

  it("finds forward and backward character targets", () => {
    expect(findCharMotionTarget("abcabc", 0, "f", "c", false, 1)).toBe(2);
    expect(findCharMotionTarget("abcabc", 0, "t", "c", false, 1)).toBe(1);
    expect(findCharMotionTarget("abcabc", 5, "F", "a", false, 1)).toBe(3);
    expect(findCharMotionTarget("abcabc", 5, "T", "a", false, 1)).toBe(4);
  });
});
