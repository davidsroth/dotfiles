import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTranscriptText, readTranscript, redactSecrets, visibleEntriesOnBranch } from "../src/transcript";
import { message, sessionJsonl, writeSession } from "./helpers";

describe("transcript policy", () => {
	it("extracts only ordinary visible user and assistant text", () => {
		const raw = sessionJsonl({
			entries: [
				message("u1", null, "user", [
					{ type: "text", text: "visible user" },
					{ type: "image", data: "hidden-image-secret" },
				]),
				message("a1", "u1", "assistant", [
					{ type: "thinking", thinking: "hidden reasoning" },
					{ type: "toolCall", name: "bash", arguments: { token: "hidden-tool-argument" } },
					{ type: "text", text: "visible assistant" },
				]),
				message("t1", "a1", "toolResult", [{ type: "text", text: "hidden tool result" }]),
				{
					type: "custom_message",
					id: "c1",
					parentId: "t1",
					timestamp: "2026-08-10T12:02:00.000Z",
					content: "hidden custom message",
					display: true,
				},
				{
					type: "compaction",
					id: "x1",
					parentId: "c1",
					timestamp: "2026-08-10T12:03:00.000Z",
					summary: "hidden summary",
				},
			],
		});
		const parsed = parseTranscriptText(raw);
		expect(parsed.visibleEntries.map((entry) => entry.text)).toEqual(["visible user", "visible assistant"]);
		expect(JSON.stringify({ entries: parsed.entries, visible: parsed.visibleEntries })).not.toMatch(/hidden/);
	});

	it("selects the branch ending at an explicit entry anchor", () => {
		const parsed = parseTranscriptText(
			sessionJsonl({
				entries: [
					message("root", null, "user", [{ type: "text", text: "root" }]),
					message("left", "root", "assistant", [{ type: "text", text: "left" }]),
					message("right", "root", "assistant", [{ type: "text", text: "right" }]),
				],
			}),
		);
		expect(visibleEntriesOnBranch(parsed, "left").map((entry) => entry.text)).toEqual(["root", "left"]);
		expect(visibleEntriesOnBranch(parsed).map((entry) => entry.text)).toEqual(["root", "right"]);
	});

	it("selects the newest leaf branch containing an anchor and keeps later descendants", () => {
		const parsed = parseTranscriptText(
			sessionJsonl({
				entries: [
					message("root", null, "user", [{ type: "text", text: "root" }], "2026-08-10T12:00:00.000Z"),
					message("matched", "root", "user", [{ type: "text", text: "question on branch A" }], "2026-08-10T12:01:00.000Z"),
					message("answer", "matched", "assistant", [{ type: "text", text: "later answer on branch A" }], "2026-08-10T12:03:00.000Z"),
					message("other", "root", "assistant", [{ type: "text", text: "newer unrelated branch B" }], "2026-08-10T12:04:00.000Z"),
				],
			}),
		);
		expect(visibleEntriesOnBranch(parsed, "matched").map((entry) => entry.id)).toEqual(["root", "matched", "answer"]);
	});

	it("detects a source change while retaining the initial descriptor snapshot", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-recall-snapshot-"));
		const path = join(root, "session.jsonl");
		await writeSession(path, sessionJsonl({ entries: [message("u1", null, "user", [{ type: "text", text: "snapshot" }])] }));
		const parsed = await readTranscript(path, {
			afterSnapshot: () => appendFile(path, `${JSON.stringify(message("u2", "u1", "user", [{ type: "text", text: "appended" }]))}\n`),
		});
		expect(parsed.sourceChanged).toBe(true);
		expect(parsed.visibleEntries.map((entry) => entry.id)).toEqual(["u1"]);
		expect(parsed.bytesRead).toBe(parsed.initialSize);
	});
});

describe("secret redaction", () => {
	it("masks labeled AWS secrets and incomplete private-key blocks", () => {
		const awsValue = "A".repeat(40);
		const keyBody = "B".repeat(256);
		const result = redactSecrets([
			`AWS_SECRET_ACCESS_KEY=${awsValue}`,
			`-----BEGIN PRIVATE KEY-----\n${keyBody}`,
		].join("\n"));
		expect(result.count).toBe(2);
		expect(result.text).not.toContain(awsValue);
		expect(result.text).not.toContain(keyBody);
		expect(result.text).toContain("[REDACTED:credential]");
		expect(result.text).toContain("[REDACTED:private-key]");
	});

	it("masks high-confidence token, bearer, credential, and private-key shapes", () => {
		const input = [
			"api_key=abcdefghijklmnopqrstuv",
			"Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234",
			"ghp_abcdefghijklmnopqrstuvwxyz123456",
			"-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
		].join("\n");
		const result = redactSecrets(input);
		expect(result.count).toBe(4);
		expect(result.text).not.toContain("abcdefghijklmnopqrstuv");
		expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz1234");
		expect(result.text).not.toContain("\nsecret\n");
	});
});
