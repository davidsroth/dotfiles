import { describe, expect, it } from "vitest";
import { tokenize, wordDiff } from "../extensions/draft/diff";

describe("tokenize", () => {
	it("splits words, whitespace, and punctuation independently", () => {
		expect(tokenize("foo, bar.")).toEqual(["foo", ",", " ", "bar", "."]);
	});

	it("returns empty array for empty string", () => {
		expect(tokenize("")).toEqual([]);
	});
});

describe("wordDiff", () => {
	it("returns empty string for identical inputs", () => {
		expect(wordDiff("hello world", "hello world")).toBe("");
	});

	it("marks pure insertions", () => {
		expect(wordDiff("hello", "hello world")).toBe("hello{+ world+}");
	});

	it("marks pure deletions", () => {
		expect(wordDiff("hello world", "hello")).toBe("hello{- world-}");
	});

	it("renders a replacement as del-then-ins", () => {
		expect(wordDiff("hello world", "hello there")).toBe("hello {-world-}{+there+}");
	});

	it("does not drag adjacent words into punctuation-only changes", () => {
		// removing the trailing period should only touch the "."
		expect(wordDiff("done.", "done")).toBe("done{-.-}");
	});
});
