import { mkdtemp, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatSearchResult, searchSessions } from "../src/search";
import { message, sessionJsonl, writeSession } from "./helpers";

const roots: string[] = [];
async function fixtureRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-recall-browse-"));
	roots.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const visible = (id: string, timestamp: string, text = id, role: "user" | "assistant" = "user") =>
	message(id, null, role, [{ type: "text", text }], timestamp);

describe("empty-query browsing", () => {
	it("ranks by visible recency rather than count, creation time, filename, or mtime", async () => {
		const root = await fixtureRoot();
		const older = join(root, "a.jsonl");
		const newer = join(root, "z.jsonl");
		await writeSession(older, sessionJsonl({
			id: "older",
			timestamp: "2026-09-01T00:00:00Z",
			entries: Array.from({ length: 6 }, (_, i) => visible(`old-${i}`, "2026-08-10T12:00:00Z")),
		}));
		await writeSession(newer, sessionJsonl({
			id: "newer",
			timestamp: "2026-01-01T00:00:00Z",
			// Deliberately out of order, with differing UTC offsets.
			entries: [
				visible("first", "2026-08-10T12:00:00Z"),
				visible("latest", "2026-08-11T08:00:00-07:00", "Recent discussion"),
				visible("second", "2026-08-11T14:00:00Z"),
				visible("third", "2026-08-11T13:00:00Z"),
			],
		}));
		await utimes(newer, 1, 1);
		await utimes(older, 2, 2);

		const result = await searchSessions({ query: "", root });
		expect(result.matches.map((match) => match.sessionId)).toEqual(["newer", "older"]);
		expect(result.matches[0].matchCount).toBe(4);
		expect(result.matches[0].snippets.map((snippet) => snippet.entryId)).toEqual(["latest", "second", "third"]);
		expect(result.matches[0].hash).toMatch(/^[a-f0-9]{64}$/);
		expect(formatSearchResult("", result)).toContain("Qualifying visible messages: 4");
		expect(formatSearchResult("", result)).toContain("newest qualifying visible message first");
		const whitespace = await searchSessions({ query: " \n\t ", root, limit: 1 });
		expect(whitespace.matches.map((match) => match.sessionId)).toEqual(["newer"]);
		expect(formatSearchResult(" \n\t ", whitespace)).toContain("Found 1 recent past session(s)");
	});

	it("preserves exact CWD, role, timezone/date filters and current-session exclusion", async () => {
		const root = await fixtureRoot();
		const path = join(root, "current.jsonl");
		await writeSession(path, sessionJsonl({
			cwd: "/work/exact",
			entries: [
				visible("before", "2026-08-11T06:59:00Z"),
				visible("after", "2026-08-11T07:01:00Z", "qualifying", "assistant"),
				visible("next-day", "2026-08-12T07:01:00Z", "too late", "assistant"),
			],
		}));
		const options = {
			query: "", root, currentSessionPath: path, cwd: "/work/exact", role: "assistant" as const,
			startDate: "2026-08-11", endDate: "2026-08-11", timezone: "America/Los_Angeles",
		};
		expect((await searchSessions(options)).matches).toEqual([]);
		const result = await searchSessions({ ...options, includeCurrent: true });
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].matchCount).toBe(1);
		expect(result.matches[0].snippets.map((snippet) => snippet.entryId)).toEqual(["after"]);
		expect((await searchSessions({ ...options, includeCurrent: true, cwd: "/work" })).matches).toEqual([]);
		expect((await searchSessions({ ...options, includeCurrent: true, role: "user" })).matches).toEqual([]);
	});

	it("omits non-visible evidence and symlinks, and redacts before clipping recent snippets", async () => {
		const root = await fixtureRoot();
		const path = join(root, "visible.jsonl");
		await writeSession(path, sessionJsonl({ entries: [
			visible("dropped", "2026-08-10T00:00:00Z", `password=${"x".repeat(24)}`),
			visible("older", "2026-08-10T01:00:00Z"),
			visible("middle", "2026-08-10T02:00:00Z"),
			visible("latest", "2026-08-10T03:00:00Z", `-----BEGIN PRIVATE KEY-----\n${"K".repeat(1_000)}\n-----END PRIVATE KEY-----`),
		] }));
		await writeSession(join(root, "hidden.jsonl"), sessionJsonl({ id: "hidden", entries: [
			message("tool", null, "toolResult", [{ type: "text", text: "hidden tool output" }]),
			message("thinking", null, "assistant", [{ type: "thinking", thinking: "hidden thinking" }]),
			message("image", null, "user", [{ type: "image", data: "hidden image" }]),
			message("blank", null, "assistant", [{ type: "text", text: "  " }]),
			{ type: "custom_message", id: "custom", content: "hidden custom" },
			{ type: "compaction", id: "summary", summary: "hidden summary" },
		] }));
		await writeSession(join(root, "empty.jsonl"), sessionJsonl({ id: "empty" }));
		await writeSession(join(root, "malformed.jsonl"), "not JSON\n");
		await symlink(path, join(root, "link.jsonl"));
		await symlink(root, join(root, "loop"));
		const result = await searchSessions({ query: "", root });
		expect(result.matches).toHaveLength(1);
		expect(result.candidateCount).toBe(4);
		expect(result.skippedFiles).toBe(1);
		expect(result.matches[0].redactionCount).toBe(1); // Counts retained snippets, not dropped ones.
		const formatted = formatSearchResult("", result);
		expect(formatted).toContain("[REDACTED:private-key]");
		expect(formatted).not.toContain("K".repeat(40));
		expect(formatted).not.toContain("hidden");
	});

	it("selects the newest 500 files before applying filters and explicitly reports incompleteness", async () => {
		const root = await fixtureRoot();
		for (let i = 0; i < 501; i++) {
			const path = join(root, `${String(i).padStart(3, "0")}.jsonl`);
			await writeSession(path, sessionJsonl({
				id: `session-${i}`, cwd: i === 500 ? "/old-project" : "/recent-project",
				entries: [visible("entry", "2026-08-10T12:00:00Z")],
			}));
			// Lexically last file is oldest; all others are kept.
			await utimes(path, 501 - i, 501 - i);
		}
		const result = await searchSessions({ query: "", root });
		expect(result.candidateCount).toBe(500);
		expect(result.candidateLimitReached).toBe(true);
		expect(result.matches).toHaveLength(10);
		expect(formatSearchResult("", result)).toContain("500 most recently modified session files");
		const filtered = await searchSessions({ query: "", root, cwd: "/old-project" });
		expect(filtered.matches).toEqual([]);
		expect(formatSearchResult("", filtered)).toContain("older matching sessions may be omitted");
		// Make the last file newest: it must now be selected despite traversal order.
		await utimes(join(root, "500.jsonl"), 1000, 1000);
		expect((await searchSessions({ query: "", root, cwd: "/old-project" })).matches[0].sessionId).toBe("session-500");
	}, 30_000);

	it("handles no results, validation and cancellation without requiring a literal query", async () => {
		const root = await fixtureRoot();
		const result = await searchSessions({ query: "", root });
		expect(formatSearchResult("", result)).toBe("No past sessions had visible user/assistant messages matching the browse filters.");
		await expect(searchSessions({ query: "", root, startDate: "2026-02-30" })).rejects.toThrow("not a valid date");
		await expect(searchSessions({ query: "", root, timezone: "Invalid/Zone" })).rejects.toThrow("Invalid IANA timezone");
		await expect(searchSessions({ query: "", root, limit: 11 })).rejects.toThrow("limit must be");
		await expect(searchSessions({ query: "x".repeat(501), root })).rejects.toThrow("500 characters");
		const controller = new AbortController();
		controller.abort();
		await expect(searchSessions({ query: "", root, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
		const during = new AbortController();
		await expect(searchSessions({
			query: "", root, signal: during.signal, onProgress: () => during.abort(),
		})).rejects.toMatchObject({ name: "AbortError" });
	});
});
