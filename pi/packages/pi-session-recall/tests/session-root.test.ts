import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveSessionRoot, normalizeSessionPath, validateSessionPath } from "../src/session-root";

describe("session root", () => {
	it("uses the default store above per-CWD directories and preserves custom roots", () => {
		expect(effectiveSessionRoot("/agent/sessions/--work--", "/agent")).toBe("/agent/sessions");
		expect(effectiveSessionRoot("/custom/sessions", "/agent")).toBe("/custom/sessions");
	});

	it("normalizes one @ sigil and rejects NUL, URL, and relative inputs", () => {
		expect(normalizeSessionPath("@/tmp/example.jsonl")).toBe("/tmp/example.jsonl");
		expect(() => normalizeSessionPath("@@/tmp/example.jsonl")).toThrow(/absolute/);
		expect(() => normalizeSessionPath("relative/session.jsonl")).toThrow(/absolute/);
		expect(() => normalizeSessionPath("file:///tmp/session.jsonl")).toThrow(/URL/);
		expect(() => normalizeSessionPath("/tmp/bad\0session.jsonl")).toThrow(/NUL/);
	});

	it("accepts regular files and rejects traversal and symlinked files", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-recall-root-"));
		const root = join(base, "sessions");
		await mkdir(root);
		const good = join(root, "good.jsonl");
		const outside = join(base, "outside.jsonl");
		await writeFile(good, "{}\n");
		await writeFile(outside, "{}\n");
		await symlink(good, join(root, "linked.jsonl"));

		await expect(validateSessionPath(`@${good}`, root)).resolves.toMatchObject({ path: await realpath(good) });
		await expect(validateSessionPath(outside, root)).rejects.toThrow(/outside/);
		await expect(validateSessionPath(join(root, "linked.jsonl"), root)).rejects.toThrow(/Symlinked/);
	});
});
