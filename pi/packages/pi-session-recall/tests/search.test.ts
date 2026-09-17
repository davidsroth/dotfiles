import { mkdtemp, open, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatSearchResult, searchSessions } from "../src/search";
import { message, sessionJsonl, writeSession } from "./helpers";

describe("session search", () => {
	it("recomputes literal matches from allowed visible text and returns provenance", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-search-"));
		const visiblePath = join(root, "project", "visible.jsonl");
		const forbiddenPath = join(root, "project", "forbidden.jsonl");
		await writeSession(
			visiblePath,
			sessionJsonl({
				id: "visible-session",
				cwd: "/work/one",
				timestamp: "2026-08-10T01:00:00.000Z",
				entries: [
					message("u1", null, "user", [
						{ type: "text", text: "Needle literal \"quoted\" api_key=abcdefghijklmnopqrstuv" },
					]),
					{
						type: "session_info",
						id: "name",
						parentId: "u1",
						timestamp: "2026-08-10T01:02:00.000Z",
						name: "Visible session",
					},
				],
			}),
		);
		await writeSession(
			forbiddenPath,
			sessionJsonl({
				id: "forbidden-session",
				entries: [message("t1", null, "toolResult", [{ type: "text", text: "Needle only in tool output" }])],
			}),
		);

		const result = await searchSessions({ query: "needle", root, timezone: "UTC" });
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({
			sessionId: "visible-session",
			sessionName: "Visible session",
			cwd: "/work/one",
			path: await realpath(visiblePath),
			matchCount: 1,
			redactionCount: 1,
		});
		expect(result.matches[0].hash).toMatch(/^[a-f0-9]{64}$/);
		expect(result.matches[0].snippets[0].text).toContain("[REDACTED:credential]");
		expect(result.matches[0].snippets[0].text).not.toContain("abcdefghijklmnopqrstuv");
		const formatted = formatSearchResult("needle", result);
		expect(formatted).toContain("entry=u1");
		expect(formatted).toContain("Historical assistant statements are reports");
		await expect(searchSessions({ query: "literal \"quoted\"", root })).resolves.toMatchObject({
			matches: [{ sessionId: "visible-session" }],
		});
	});

	it("applies exact CWD, role/date filters, and current-session exclusion", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-filter-"));
		const path = join(root, "match.jsonl");
		await writeSession(
			path,
			sessionJsonl({
				cwd: "/work/exact",
				timestamp: "2026-08-11T01:00:00.000Z",
				entries: [
					message(
						"a1",
						null,
						"assistant",
						[{ type: "text", text: "FilterNeedle" }],
						"2026-08-11T12:01:00.000Z",
					),
				],
			}),
		);

		await expect(
			searchSessions({ query: "filterneedle", root, currentSessionPath: path }),
		).resolves.toMatchObject({ matches: [] });
		await expect(
			searchSessions({
				query: "filterneedle",
				root,
				includeCurrent: true,
				cwd: "/work/exact",
				role: "assistant",
				startDate: "2026-08-11",
				endDate: "2026-08-11",
				timezone: "UTC",
			}),
		).resolves.toMatchObject({ matches: [{ sessionId: "session-1" }] });
		await expect(
			searchSessions({ query: "filterneedle", root, includeCurrent: true, role: "user" }),
		).resolves.toMatchObject({ matches: [] });
	});

	it("applies date boundaries to each matching message in the requested timezone", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-timezone-"));
		const path = join(root, "boundary.jsonl");
		await writeSession(
			path,
			sessionJsonl({
				timestamp: "2026-07-01T00:00:00.000Z",
				entries: [
					message("before", null, "user", [{ type: "text", text: "BoundaryNeedle before" }], "2026-08-11T06:59:00.000Z"),
					message("after", "before", "assistant", [{ type: "text", text: "BoundaryNeedle after" }], "2026-08-11T07:01:00.000Z"),
				],
			}),
		);

		const result = await searchSessions({
			query: "boundaryneedle",
			root,
			startDate: "2026-08-11",
			endDate: "2026-08-11",
			timezone: "America/Los_Angeles",
		});
		expect(result.matches[0].matchCount).toBe(1);
		expect(result.matches[0].snippets.map((snippet) => snippet.entryId)).toEqual(["after"]);
	});

	it("redacts a complete entry before clipping a search snippet", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-search-pem-"));
		const path = join(root, "pem.jsonl");
		const keyBody = "K".repeat(1_000);
		await writeSession(path, sessionJsonl({
			entries: [message("u1", null, "user", [{
				type: "text",
				text: `SearchPemNeedle\n-----BEGIN PRIVATE KEY-----\n${keyBody}\n-----END PRIVATE KEY-----`,
			}])],
		}));

		const result = await searchSessions({ query: "SearchPemNeedle", root });
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].snippets[0].text).toContain("[REDACTED:private-key]");
		expect(result.matches[0].snippets[0].text).not.toContain("K".repeat(40));
	});

	it("streams and searches a session larger than the former 25 MB cap", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-large-"));
		const path = join(root, "large.jsonl");
		const handle = await open(path, "w");
		try {
			await handle.write(`${JSON.stringify({ type: "session", version: 3, id: "large-session", timestamp: "2026-08-10T00:00:00.000Z", cwd: "/work/large" })}\n`);
			await handle.write(`${JSON.stringify(message("u1", null, "user", [{ type: "text", text: "LargeHistoryNeedle" }]))}\n`);
			const payload = "x".repeat(64 * 1024);
			for (let index = 0; index < 410; index++) {
				await handle.write(`${JSON.stringify({ type: "custom", id: `pad-${index}`, parentId: index ? `pad-${index - 1}` : "u1", timestamp: "2026-08-10T12:02:00.000Z", customType: "padding", data: payload })}\n`);
			}
		} finally {
			await handle.close();
		}
		expect((await stat(path)).size).toBeGreaterThan(25_000_000);

		const result = await searchSessions({ query: "largehistoryneedle", root });
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({ sessionId: "large-session", matchCount: 1 });
	}, 30_000);
});
