import { describe, expect, it } from "vitest";
import { formatDraftRejection, parseDraftDecision } from "../extensions/draft/index";
import {
	findLastAssistantText,
	formatLastReply,
	formatPlanFeedback,
	parseReviewDecision,
	truncate,
} from "../extensions/miniplan/index";

describe("truncate", () => {
	it("leaves short strings intact", () => {
		expect(truncate("abc", 10)).toBe("abc");
	});
	it("truncates with an ellipsis", () => {
		expect(truncate("abcdef", 4)).toBe("abc\u2026");
	});
});

describe("formatPlanFeedback", () => {
	it("orders inline comments before general feedback", () => {
		const out = formatPlanFeedback({
			approved: false,
			feedback: "overall looks good",
			comments: [{ id: 1, selectedText: "foo", text: "rename this" }],
		});
		expect(out.indexOf("## Inline comments")).toBeLessThan(out.indexOf("## General feedback"));
		expect(out).toContain("\u201cfoo\u201d \u2014 rename this");
	});

	it("includes context when it differs from the selection", () => {
		const out = formatPlanFeedback({
			approved: false,
			comments: [{ id: 1, selectedText: "foo", context: "the foo bar", text: "x" }],
		});
		expect(out).toContain("(in: \u201cthe foo bar\u201d)");
	});
});

describe("formatLastReply", () => {
	it("returns just the feedback when there are no comments", () => {
		expect(formatLastReply({ approved: false, feedback: "hi" })).toBe("hi");
	});

	it("uses the compact single-note form", () => {
		expect(
			formatLastReply({ approved: false, comments: [{ id: 1, selectedText: "foo", text: "fix" }] }),
		).toBe("Re \u201cfoo\u201d: fix");
	});

	it("orders comments BEFORE the freeform reply", () => {
		const out = formatLastReply({
			approved: false,
			feedback: "and one more thing",
			comments: [
				{ id: 1, selectedText: "a", text: "note A" },
				{ id: 2, selectedText: "b", text: "note B" },
			],
		});
		expect(out.indexOf("note A")).toBeLessThan(out.indexOf("and one more thing"));
		expect(out.indexOf("note B")).toBeLessThan(out.indexOf("and one more thing"));
	});
});

describe("parseReviewDecision", () => {
	it("coerces types and whitelists the action", () => {
		const r = parseReviewDecision({
			action: "approve",
			approved: true,
			feedback: "ok",
			comments: [{ id: 1, selectedText: "s", text: "t" }],
		});
		expect(r).toEqual({
			action: "approve",
			approved: true,
			feedback: "ok",
			comments: [{ id: 1, selectedText: "s", context: undefined, text: "t" }],
		});
	});

	it("drops an unknown action and coerces approved to a boolean", () => {
		const r = parseReviewDecision({ action: "evil", approved: "yes" });
		expect(r.action).toBeUndefined();
		expect(r.approved).toBe(false);
	});

	it("drops comments with empty text and non-object entries", () => {
		const r = parseReviewDecision({ comments: [{ selectedText: "s", text: "  " }, null, "x"] });
		expect(r.comments).toEqual([]);
	});

	it("accepts the cancel action", () => {
		expect(parseReviewDecision({ action: "cancel" }).action).toBe("cancel");
	});
});

describe("parseDraftDecision", () => {
	it("maps known actions", () => {
		expect(parseDraftDecision({ action: "approve", text: "x" })).toEqual({ action: "approve", text: "x" });
		expect(parseDraftDecision({ action: "copy", text: "x" })).toEqual({ action: "copy", text: "x" });
		expect(parseDraftDecision({ action: "reject", text: "x", feedback: " revise this " })).toEqual({
			action: "reject",
			text: "x",
			feedback: "revise this",
		});
	});
	it("falls back to cancel for unknown actions or rejection without feedback", () => {
		expect(parseDraftDecision({ action: "evil" }).action).toBe("cancel");
		expect(parseDraftDecision({}).action).toBe("cancel");
		expect(parseDraftDecision({ action: "reject", feedback: "  " }).action).toBe("cancel");
	});
	it("defaults missing text to empty string", () => {
		expect(parseDraftDecision({ action: "copy" }).text).toBe("");
	});
});

describe("formatDraftRejection", () => {
	it("instructs the agent not to post and to revise and resubmit", () => {
		const out = formatDraftRejection("hello", "hello", "Make it warmer.");
		expect(out).toContain("REJECTED — user rejected the draft");
		expect(out).toContain("Do NOT post it");
		expect(out).toContain("Revise it according to the feedback below");
		expect(out).toContain("call submit_draft again");
		expect(out).toContain("Feedback:\n\nMake it warmer.");
		expect(out).not.toContain("Edits made before rejection");
	});

	it("includes a word-level diff when the draft was edited before rejection", () => {
		const out = formatDraftRejection("hello world", "hello there", "Use my edit.");
		expect(out).toContain("Edits made before rejection:\n\nhello {-world-}{+there+}");
	});
});

describe("findLastAssistantText", () => {
	const assistant = (text: string | null, stopReason = "stop") => ({
		type: "message",
		id: "x",
		message: {
			role: "assistant",
			stopReason,
			content: text === null ? [] : [{ type: "text", text }],
		},
	});

	it("returns the last completed assistant reply", () => {
		const branch = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			assistant("the answer"),
		];
		expect(findLastAssistantText(branch)?.text).toBe("the answer");
	});

	it("skips intermediate toolUse turns", () => {
		const branch = [
			assistant("real reply"),
			assistant("let me check…", "toolUse"),
		];
		expect(findLastAssistantText(branch)?.text).toBe("real reply");
	});

	it("reports incomplete when the latest completed reply has no text", () => {
		const branch = [assistant(null)];
		expect(findLastAssistantText(branch)?.incompleteReason).toBe("no text");
	});

	it("returns null when there is no assistant message", () => {
		const branch = [{ type: "message", message: { role: "user", content: [] } }];
		expect(findLastAssistantText(branch)).toBeNull();
	});
});
