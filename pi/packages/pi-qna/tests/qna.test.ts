/**
 * Tests for the pure helper functions in qna.ts.
 *
 * Hermetic: no real network, no real child processes, no reads of the user's
 * real config or memory files.  node:fs is mocked throughout for all stash
 * I/O tests.
 *
 * Coverage:
 *  - parseExtractorResponse (happy path, fence stripping, filtering, regex fallback)
 *  - findLastAssistantText (finds completed, skips incomplete, null on no match)
 *  - buildQAFromAnswers (formats blocks, length mismatch)
 *  - firstUnansweredIndex (first blank, all-filled, empty)
 *  - readStashFromDisk (valid, invalid shape, file missing, stale TTL)
 *  - writeStashToDisk (creates dir and writes, swallows errors)
 *  - loadStash (module-scope fast path, falls back to disk)
 *  - saveStash (completed flag round-trip)
 *  - resolveStartIndex (lastIndex clamping)
 *  - argTokens resume aliases (tested via pure inline logic)
 *  - wrapText (basic wrapping, zero width)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs before importing the module under test.
vi.mock("node:fs");

// Mock @earendil-works/pi-tui so wrapText/buildFrame work without ANSI libs.
vi.mock("@earendil-works/pi-tui", () => ({
	visibleWidth: (s: string) => s.length,
	truncateToWidth: (s: string, w: number) => s.slice(0, w),
	Editor: class {},
	Key: {},
	matchesKey: () => false,
	BorderedLoader: class {},
}));

// Mock the heavy peer deps that are imported at module level but not needed for
// the pure-function tests.
vi.mock("@earendil-works/pi-ai", () => ({}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	BorderedLoader: class {},
}));
vi.mock("typebox", () => ({ Type: { Object: () => ({}), Array: () => ({}), String: () => ({}) } }));

import * as fs from "node:fs";
import {
	STASH_PATH,
	STASH_TTL_MS,
	_resetLastStash,
	buildQAFromAnswers,
	buildFrame,
	findLastAssistantText,
	HERDR_BLOCKED_EVENT,
	HERDR_BLOCKED_LABEL,
	firstUnansweredIndex,
	loadStash,
	parseExtractorResponse,
	readStashFromDisk,
	resolveStartIndex,
	runQnaCardUI,
	saveStash,
	setHerdrBlocked,
	wrapText,
	writeStashToDisk,
	type QnaStash,
} from "../extensions/qna.js";

// ---------------------------------------------------------------------------
// Herdr blocked-state integration
// ---------------------------------------------------------------------------

describe("setHerdrBlocked", () => {
	it("emits the event consumed by Herdr's Pi integration", () => {
		const emit = vi.fn();
		const pi = { events: { emit } } as any;

		setHerdrBlocked(pi, true);
		setHerdrBlocked(pi, false);

		expect(emit).toHaveBeenNthCalledWith(1, HERDR_BLOCKED_EVENT, {
			active: true,
			label: HERDR_BLOCKED_LABEL,
		});
		expect(emit).toHaveBeenNthCalledWith(2, HERDR_BLOCKED_EVENT, {
			active: false,
			label: HERDR_BLOCKED_LABEL,
		});
	});

	it("does not let an integration listener failure break Q&A", () => {
		const pi = {
			events: {
				emit: () => {
					throw new Error("listener failed");
				},
			},
		} as any;

		expect(() => setHerdrBlocked(pi, true)).not.toThrow();
	});

	it("balances blocked state around a successful Q&A dialog", async () => {
		const emit = vi.fn();
		const result = { kind: "cancel", stashed: false, typedCount: 0 } as const;
		const pi = { events: { emit } } as any;
		const ctx = { ui: { custom: vi.fn().mockResolvedValue(result) } } as any;

		await expect(
			runQnaCardUI(pi, ctx, { questions: ["Continue?"] }),
		).resolves.toEqual(result);
		expect(emit.mock.calls.map(([, payload]) => payload.active)).toEqual([true, false]);
		expect(emit.mock.calls[0]![1].id).toMatch(/^qna:/);
		expect(emit.mock.calls[1]![1].id).toBe(emit.mock.calls[0]![1].id);
	});

	it("clears blocked state when the Q&A dialog rejects", async () => {
		const emit = vi.fn();
		const pi = { events: { emit } } as any;
		const ctx = {
			ui: { custom: vi.fn().mockRejectedValue(new Error("UI failed")) },
		} as any;

		await expect(
			runQnaCardUI(pi, ctx, { questions: ["Continue?"] }),
		).rejects.toThrow("UI failed");
		expect(emit.mock.calls.map(([, payload]) => payload.active)).toEqual([true, false]);
		expect(emit.mock.calls[1]![1].id).toBe(emit.mock.calls[0]![1].id);
	});
});

// ---------------------------------------------------------------------------
// parseExtractorResponse
// ---------------------------------------------------------------------------

describe("parseExtractorResponse", () => {
	it("happy path: parses valid JSON questions array", () => {
		const result = parseExtractorResponse('{"questions":["Is this right?","What next?"]}');
		expect(result).toEqual(["Is this right?", "What next?"]);
	});

	it("trims whitespace from each question", () => {
		const result = parseExtractorResponse('{"questions":["  Is this right?  "]}');
		expect(result).toEqual(["Is this right?"]);
	});

	it("strips leading ```json fence", () => {
		const input = '```json\n{"questions":["Is this correct?"]}\n```';
		const result = parseExtractorResponse(input);
		expect(result).toEqual(["Is this correct?"]);
	});

	it("strips bare ``` fence without language tag", () => {
		const input = '```\n{"questions":["Is this correct?"]}\n```';
		const result = parseExtractorResponse(input);
		expect(result).toEqual(["Is this correct?"]);
	});

	it("filters out non-string array elements", () => {
		const result = parseExtractorResponse('{"questions":[42, null, "", "  ", "Valid?"]}');
		expect(result).toEqual(["Valid?"]);
	});

	it("returns [] for empty questions array", () => {
		const result = parseExtractorResponse('{"questions":[]}');
		expect(result).toEqual([]);
	});

	it("falls through to regex fallback when questions key is missing", () => {
		// valid JSON but no 'questions' key — no quoted '?'-ending strings either
		const result = parseExtractorResponse('{"result":[]}');
		expect(result).toEqual([]);
	});

	it("regex fallback: keeps quoted strings ending in '?' with length > 2", () => {
		const input = 'Here are the questions: "What is this?" "Tell me more." "Ready?"';
		const result = parseExtractorResponse(input);
		// "Tell me more." does not end in '?'; "Ready?" is 6 chars > 2
		expect(result).toContain("What is this?");
		expect(result).toContain("Ready?");
		expect(result).not.toContain("Tell me more.");
	});

	it("regex fallback: returns [] when no quoted '?'-ending strings present", () => {
		const result = parseExtractorResponse("completely invalid { no quotes at all");
		expect(result).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// findLastAssistantText
// ---------------------------------------------------------------------------

function makeAssistantEntry(text: string, stopReason = "stop") {
	return {
		type: "message",
		message: {
			role: "assistant",
			stopReason,
			content: [{ type: "text", text }],
		},
	};
}

function makeUserEntry(text: string) {
	return {
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text }],
		},
	};
}

describe("findLastAssistantText", () => {
	it("returns the text of the last completed assistant message", () => {
		const branch = [makeUserEntry("hello"), makeAssistantEntry("Hello there?")];
		const result = findLastAssistantText(branch);
		expect(result).toEqual({ text: "Hello there?" });
	});

	it("joins multiple text content blocks with newline", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [
						{ type: "text", text: "Part one." },
						{ type: "text", text: "Part two." },
					],
				},
			},
		];
		const result = findLastAssistantText(branch);
		expect(result).toEqual({ text: "Part one.\nPart two." });
	});

	it("returns {text:'', incompleteReason} when stopReason is not 'stop'", () => {
		const branch = [makeAssistantEntry("truncated", "max_tokens")];
		const result = findLastAssistantText(branch);
		expect(result).toEqual({ text: "", incompleteReason: "max_tokens" });
	});

	it("returns {text:'', incompleteReason:'tool_use'} for tool_use stopReason", () => {
		const branch = [makeAssistantEntry("tool call", "tool_use")];
		const result = findLastAssistantText(branch);
		expect(result).toEqual({ text: "", incompleteReason: "tool_use" });
	});

	it("returns null for an empty branch array", () => {
		expect(findLastAssistantText([])).toBeNull();
	});

	it("returns null when only user-role messages are present", () => {
		const branch = [makeUserEntry("hello"), makeUserEntry("world")];
		expect(findLastAssistantText(branch)).toBeNull();
	});

	it("skips entries with type !== 'message'", () => {
		const branch = [
			makeAssistantEntry("Valid answer?"),
			{ type: "tool_result", message: { role: "assistant", stopReason: "stop", content: [] } },
		];
		// Last entry is tool_result (skipped), second-to-last is the assistant message
		const result = findLastAssistantText(branch);
		expect(result).toEqual({ text: "Valid answer?" });
	});

	it("picks the last assistant message when multiple are present", () => {
		const branch = [
			makeAssistantEntry("First?"),
			makeUserEntry("answer"),
			makeAssistantEntry("Second?"),
		];
		const result = findLastAssistantText(branch);
		expect(result).toEqual({ text: "Second?" });
	});
});

// ---------------------------------------------------------------------------
// buildQAFromAnswers
// ---------------------------------------------------------------------------

describe("buildQAFromAnswers", () => {
	it("formats Q:/A: blocks numbered from 1", () => {
		const result = buildQAFromAnswers(["What is X?", "Why?"], ["Because.", "  Trim me.  "]);
		expect(result).toBe("Q1: What is X?\nA: Because.\n\nQ2: Why?\nA: Trim me.");
	});

	it("trims answers", () => {
		const result = buildQAFromAnswers(["Q?"], ["  spaces  "]);
		expect(result).toBe("Q1: Q?\nA: spaces");
	});

	it("handles empty answer string", () => {
		const result = buildQAFromAnswers(["Q?"], [""]);
		// trimEnd() removes trailing space, so "A: " becomes "A:"
		expect(result).toBe("Q1: Q?\nA:");
	});

	it("handles length mismatch: missing answer defaults to empty", () => {
		const result = buildQAFromAnswers(["Q1?", "Q2?"], ["only one answer"]);
		// Q2 should have empty answer; trimEnd may strip trailing space on last block
		expect(result).toContain("Q2: Q2?");
		// The empty answer is the last one — trimEnd trims trailing "A: " whitespace
		expect(result).toContain("Q2: Q2?\nA:");
	});

	it("does not end with a trailing newline", () => {
		const result = buildQAFromAnswers(["Q?"], ["A"]);
		expect(result.endsWith("\n")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// firstUnansweredIndex
// ---------------------------------------------------------------------------

describe("firstUnansweredIndex", () => {
	it("returns index of first blank answer", () => {
		expect(firstUnansweredIndex(["yes", "", "no"])).toBe(1);
	});

	it("treats whitespace-only answer as blank", () => {
		expect(firstUnansweredIndex(["yes", "  ", "no"])).toBe(1);
	});

	it("returns last index when all answers are filled", () => {
		expect(firstUnansweredIndex(["a", "b", "c"])).toBe(2);
	});

	it("returns 0 for empty array", () => {
		expect(firstUnansweredIndex([])).toBe(0);
	});

	it("returns 0 when first answer is blank", () => {
		expect(firstUnansweredIndex(["", "filled"])).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// readStashFromDisk / writeStashToDisk
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function validStashJson(overrides: Partial<QnaStash> = {}): string {
	return JSON.stringify({
		questions: ["Q?"],
		answers: ["A"],
		sourceText: "src",
		savedAt: NOW,
		...overrides,
	});
}

describe("readStashFromDisk", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.mocked(fs.readFileSync).mockReset();
	});

	it("returns a parsed stash for valid fresh JSON", () => {
		vi.mocked(fs.readFileSync).mockReturnValue(validStashJson());
		const result = readStashFromDisk();
		expect(result).toBeDefined();
		expect(result?.questions).toEqual(["Q?"]);
		expect(result?.answers).toEqual(["A"]);
		expect(result?.sourceText).toBe("src");
	});

	it("returns undefined for empty object '{}'", () => {
		vi.mocked(fs.readFileSync).mockReturnValue("{}");
		expect(readStashFromDisk()).toBeUndefined();
	});

	it("returns undefined when sourceText/savedAt are missing", () => {
		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({ questions: [], answers: [] }),
		);
		expect(readStashFromDisk()).toBeUndefined();
	});

	it("returns the stash when its age is exactly STASH_TTL_MS (only strictly older is stale)", () => {
		vi.mocked(fs.readFileSync).mockReturnValue(
			validStashJson({ savedAt: NOW - STASH_TTL_MS }),
		);
		expect(readStashFromDisk()).toBeDefined();
	});

	it("returns undefined for 'null' JSON", () => {
		vi.mocked(fs.readFileSync).mockReturnValue("null");
		expect(readStashFromDisk()).toBeUndefined();
	});

	it("returns undefined when readFileSync throws (file not found)", () => {
		vi.mocked(fs.readFileSync).mockImplementation(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});
		expect(readStashFromDisk()).toBeUndefined();
	});

	it("returns undefined when stash is stale (older than STASH_TTL_MS)", () => {
		const staleTime = NOW - STASH_TTL_MS - 1;
		vi.mocked(fs.readFileSync).mockReturnValue(validStashJson({ savedAt: staleTime }));
		expect(readStashFromDisk()).toBeUndefined();
	});

	it("returns stash when savedAt is exactly at TTL boundary (not expired)", () => {
		// savedAt = NOW means age = 0, which is < TTL_MS
		vi.mocked(fs.readFileSync).mockReturnValue(validStashJson({ savedAt: NOW }));
		const result = readStashFromDisk();
		expect(result).toBeDefined();
	});
});

describe("writeStashToDisk", () => {
	afterEach(() => {
		vi.mocked(fs.mkdirSync).mockReset();
		vi.mocked(fs.writeFileSync).mockReset();
	});

	it("calls mkdirSync with recursive:true and writeFileSync with the stash", () => {
		vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
		vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

		const stash: QnaStash = {
			questions: ["Q?"],
			answers: ["A"],
			sourceText: "s",
			savedAt: NOW,
		};
		writeStashToDisk(stash);

		expect(fs.mkdirSync).toHaveBeenCalledWith(
			expect.stringContaining("pi-qna"),
			{ recursive: true },
		);
		expect(fs.writeFileSync).toHaveBeenCalledWith(
			STASH_PATH,
			JSON.stringify(stash),
			"utf8",
		);
	});

	it("swallows writeFileSync errors without propagating", () => {
		vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
		vi.mocked(fs.writeFileSync).mockImplementation(() => {
			throw new Error("disk full");
		});

		const stash: QnaStash = {
			questions: ["Q?"],
			answers: ["A"],
			sourceText: "s",
			savedAt: NOW,
		};
		// Should not throw
		expect(() => writeStashToDisk(stash)).not.toThrow();
	});

	it("swallows mkdirSync errors without propagating", () => {
		vi.mocked(fs.mkdirSync).mockImplementation(() => {
			throw new Error("permission denied");
		});

		const stash: QnaStash = {
			questions: ["Q?"],
			answers: ["A"],
			sourceText: "s",
			savedAt: NOW,
		};
		expect(() => writeStashToDisk(stash)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// saveStash / loadStash — module-scope state
// ---------------------------------------------------------------------------

describe("saveStash and loadStash", () => {
	beforeEach(() => {
		_resetLastStash();
		vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
		vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
		vi.mocked(fs.readFileSync).mockReset();
	});
	afterEach(() => {
		_resetLastStash();
	});

	it("loadStash returns undefined when nothing is stashed and readFileSync throws", () => {
		vi.mocked(fs.readFileSync).mockImplementation(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});
		expect(loadStash()).toBeUndefined();
	});

	it("loadStash falls back to disk when module-scope state is empty", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);

		vi.mocked(fs.readFileSync).mockReturnValue(validStashJson());
		const result = loadStash();
		expect(result).toBeDefined();
		expect(result?.questions).toEqual(["Q?"]);

		vi.useRealTimers();
	});

	it("loadStash returns module-scope stash without reading disk after saveStash", () => {
		const stash: QnaStash = {
			questions: ["Mem?"],
			answers: ["yes"],
			sourceText: "",
			savedAt: NOW,
		};
		saveStash(stash);

		// readFileSync should NOT be consulted after saveStash
		const callsBefore = vi.mocked(fs.readFileSync).mock.calls.length;
		const loaded = loadStash();
		const callsAfter = vi.mocked(fs.readFileSync).mock.calls.length;

		expect(loaded).toEqual(stash);
		expect(callsAfter).toBe(callsBefore); // no new reads
	});

	it("saveStash writes completed:true and loadStash returns it", () => {
		// Capture all writeFileSync calls
		const capturedWrites: string[] = [];
		vi.mocked(fs.writeFileSync).mockImplementation((_path, data) => {
			capturedWrites.push(String(data));
		});

		const stash: QnaStash = {
			questions: ["Q?"],
			answers: ["A"],
			sourceText: "",
			savedAt: NOW,
			completed: true,
		};
		saveStash(stash);

		// Check that writeFileSync received the completed flag
		expect(capturedWrites.length).toBeGreaterThan(0);
		const parsed = JSON.parse(capturedWrites[0]!) as QnaStash;
		expect(parsed.completed).toBe(true);

		// Verify round-trip through loadStash (uses module-scope lastStash)
		const loaded = loadStash();
		expect(loaded?.completed).toBe(true);
	});

	it("saveStash without completed flag: backward compat — readStashFromDisk still returns it", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);

		const stash: QnaStash = {
			questions: ["Q?"],
			answers: ["A"],
			sourceText: "",
			savedAt: NOW,
			// completed omitted
		};
		// Write directly to disk mock
		const written: string[] = [];
		vi.mocked(fs.writeFileSync).mockImplementation((_path, data) => {
			written.push(String(data));
		});
		writeStashToDisk(stash);

		// Now mock readFileSync to return what was written
		vi.mocked(fs.readFileSync).mockReturnValue(written[0] ?? "");

		_resetLastStash(); // ensure disk path is used
		const loaded = readStashFromDisk();
		expect(loaded).toBeDefined();
		expect(loaded?.completed).toBeUndefined();

		vi.useRealTimers();
	});
});

// ---------------------------------------------------------------------------
// resolveStartIndex
// ---------------------------------------------------------------------------

describe("resolveStartIndex", () => {
	it("returns lastIndex when it is valid", () => {
		const stash: QnaStash = {
			questions: ["Q1?", "Q2?", "Q3?"],
			answers: ["a", "", ""],
			sourceText: "",
			savedAt: NOW,
			lastIndex: 2,
		};
		expect(resolveStartIndex(stash)).toBe(2);
	});

	it("falls back to firstUnansweredIndex when lastIndex is -1", () => {
		const stash: QnaStash = {
			questions: ["Q1?", "Q2?"],
			answers: ["filled", ""],
			sourceText: "",
			savedAt: NOW,
			lastIndex: -1,
		};
		expect(resolveStartIndex(stash)).toBe(1); // first blank is index 1
	});

	it("falls back to firstUnansweredIndex when lastIndex is out of range", () => {
		const stash: QnaStash = {
			questions: ["Q1?", "Q2?"],
			answers: ["", ""],
			sourceText: "",
			savedAt: NOW,
			lastIndex: 5, // out of range
		};
		expect(resolveStartIndex(stash)).toBe(0); // first blank
	});

	it("falls back to firstUnansweredIndex when lastIndex is undefined", () => {
		const stash: QnaStash = {
			questions: ["Q1?", "Q2?", "Q3?"],
			answers: ["a", "b", ""],
			sourceText: "",
			savedAt: NOW,
			// lastIndex omitted
		};
		expect(resolveStartIndex(stash)).toBe(2);
	});

	it("returns 0 when lastIndex is 0 and 0 is valid", () => {
		const stash: QnaStash = {
			questions: ["Q1?", "Q2?"],
			answers: ["", ""],
			sourceText: "",
			savedAt: NOW,
			lastIndex: 0,
		};
		expect(resolveStartIndex(stash)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// argTokens resume aliases (inline pure logic)
// ---------------------------------------------------------------------------

describe("argTokens resume aliases", () => {
	// Mirrors the inline expression in qna.ts command handler
	function isResume(tokens: string[]): boolean {
		return tokens.some((t) => t === "--resume" || t === "-r" || t === "resume");
	}

	it("--resume is recognised", () => {
		expect(isResume(["--resume"])).toBe(true);
	});

	it("-r is recognised", () => {
		expect(isResume(["-r"])).toBe(true);
	});

	it("resume is recognised", () => {
		expect(isResume(["resume"])).toBe(true);
	});

	it("other tokens are not resume", () => {
		expect(isResume(["other", "--flag"])).toBe(false);
	});

	it("empty tokens array is not resume", () => {
		expect(isResume([])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// wrapText
// ---------------------------------------------------------------------------

describe("wrapText", () => {
	it("wraps text at word boundaries", () => {
		// "one two" = 7 chars fits in 10, "one two three" = 13 does not
		const result = wrapText("one two three four", 10);
		// Each line must be <= 10 chars
		for (const line of result) {
			expect(line.length).toBeLessThanOrEqual(10);
		}
		// Content must be preserved (re-join with spaces)
		expect(result.join(" ")).toBe("one two three four");
	});

	it("returns ['short'] when text fits in width", () => {
		expect(wrapText("short", 20)).toEqual(["short"]);
	});

	it("returns [text] unchanged when width <= 0", () => {
		expect(wrapText("hello world", 0)).toEqual(["hello world"]);
	});

	it("handles empty string", () => {
		const result = wrapText("", 20);
		// Should return at least one (possibly empty) line
		expect(Array.isArray(result)).toBe(true);
	});

	it("splits on newlines", () => {
		const result = wrapText("line one\nline two", 40);
		expect(result.length).toBeGreaterThanOrEqual(2);
		expect(result.join("\n")).toContain("line one");
		expect(result.join("\n")).toContain("line two");
	});
});

// ---------------------------------------------------------------------------
// buildFrame
// ---------------------------------------------------------------------------

describe("buildFrame", () => {
	const id = (s: string) => s;

	it("enforces minimum innerWidth of 20", () => {
		const frame = buildFrame(5, id);
		expect(frame.innerWidth).toBe(20);
		expect(frame.top).toBe("╭" + "─".repeat(20) + "╮");
		expect(frame.bot).toBe("╰" + "─".repeat(20) + "╯");
	});

	it("uses width - 2 as innerWidth when width is large enough", () => {
		const frame = buildFrame(40, id);
		expect(frame.innerWidth).toBe(38);
	});

	it("mid() pads short lines to innerWidth", () => {
		const frame = buildFrame(30, id); // innerWidth = 28
		const result = frame.mid("hi"); // visibleWidth = 2, needs 26 spaces
		expect(result).toBe("│" + "hi" + " ".repeat(26) + "│");
	});

	it("mid() truncates lines longer than innerWidth", () => {
		const frame = buildFrame(10, id); // innerWidth = max(20, 8) = 20
		const longLine = "a".repeat(30);
		const result = frame.mid(longLine);
		// truncateToWidth slices to innerWidth = 20
		expect(result).toBe("│" + "a".repeat(20) + "│");
	});
});
