/**
 * Tests for session-remote/logic.ts — wire validation, transcript summary,
 * and rename-target resolution.
 */

import { describe, expect, it } from "vitest";
import { normalizeName, parseWireMessage, type Peer, resolveTarget, summarizeEntries } from "../session-remote/logic";

function peer(overrides: Partial<Peer>): Peer {
	return {
		brokerId: "b-0000",
		piSessionId: "p-0000",
		self: false,
		name: null,
		cwd: "/tmp",
		sessionFile: null,
		mode: "tui",
		idle: true,
		messageCount: 0,
		firstPrompt: null,
		recentPrompts: [],
		lastReply: null,
		...overrides,
	};
}

describe("parseWireMessage", () => {
	it("accepts well-formed messages", () => {
		expect(parseWireMessage({ kind: "describe", requestId: "r" })).toEqual({ kind: "describe", requestId: "r" });
		expect(parseWireMessage({ kind: "rename", requestId: "r", targetSessionId: "t", name: "n", by: "b" })?.kind).toBe("rename");
	});

	it("rejects malformed payloads", () => {
		expect(parseWireMessage(null)).toBeUndefined();
		expect(parseWireMessage({ kind: "describe" })).toBeUndefined();
		expect(parseWireMessage({ kind: "rename", requestId: "r", name: "n" })).toBeUndefined();
		expect(parseWireMessage({ kind: "describe_result", requestId: "r", info: { piSessionId: "x" } })).toBeUndefined();
		expect(parseWireMessage({ kind: "bogus", requestId: "r" })).toBeUndefined();
	});
});

describe("normalizeName", () => {
	it("collapses whitespace and rejects empty names", () => {
		expect(normalizeName("  Fix   flaky\nCI ")).toBe("Fix flaky CI");
		expect(normalizeName("   ")).toBeUndefined();
		expect(normalizeName("x".repeat(500))).toHaveLength(120);
	});
});

describe("summarizeEntries", () => {
	it("extracts first/recent prompts and last reply from message entries", () => {
		const msg = (role: string, content: unknown) => ({ type: "message", message: { role, content } });
		const summary = summarizeEntries([
			{ type: "session_info", name: "x" },
			msg("user", "first"),
			msg("assistant", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "reply one" }]),
			msg("toolResult", "ignored"),
			msg("user", [{ type: "text", text: "second" }]),
			msg("user", "third"),
			msg("user", "fourth"),
			msg("user", "fifth"),
			msg("assistant", [{ type: "text", text: "reply two" }]),
		]);
		expect(summary.firstPrompt).toBe("first");
		expect(summary.recentPrompts).toEqual(["third", "fourth", "fifth"]);
		expect(summary.lastReply).toBe("reply two");
		expect(summary.messageCount).toBe(7);
	});
});

describe("resolveTarget", () => {
	const peers = [
		peer({ brokerId: "019a-aaaa", piSessionId: "019a-aaaa", name: "Dotfiles cleanup" }),
		peer({ brokerId: "019a-bbbb", piSessionId: "019a-bbbb", name: "Phoenix release" }),
		peer({ brokerId: "stable-c", piSessionId: "019a-cccc", name: null }),
	];

	it("matches exact ids and names first", () => {
		expect(resolveTarget(peers, "019a-bbbb")).toMatchObject({ ok: true, peer: { name: "Phoenix release" } });
		expect(resolveTarget(peers, "stable-c")).toMatchObject({ ok: true, peer: { piSessionId: "019a-cccc" } });
		expect(resolveTarget(peers, "019a-cccc")).toMatchObject({ ok: true, peer: { brokerId: "stable-c" } });
		expect(resolveTarget(peers, "dotfiles CLEANUP")).toMatchObject({ ok: true, peer: { brokerId: "019a-aaaa" } });
	});

	it("accepts unique prefixes and name substrings", () => {
		expect(resolveTarget(peers, "019a-c")).toMatchObject({ ok: true, peer: { brokerId: "stable-c" } });
		expect(resolveTarget(peers, "phoenix")).toMatchObject({ ok: true, peer: { brokerId: "019a-bbbb" } });
	});

	it("reports ambiguity and misses", () => {
		const ambiguous = resolveTarget(peers, "019a");
		expect(ambiguous.ok).toBe(false);
		if (!ambiguous.ok) expect(ambiguous.candidates).toHaveLength(3);
		expect(resolveTarget(peers, "nope")).toMatchObject({ ok: false, candidates: [] });
		expect(resolveTarget(peers, "019")).toMatchObject({ ok: false });
	});
});
