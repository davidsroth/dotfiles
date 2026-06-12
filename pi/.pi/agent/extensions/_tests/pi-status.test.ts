/**
 * Tests for pi-status.ts — heartbeat files for the tmux session picker.
 *
 * Hermetic: heartbeats are written to a mkdtemp dir injected via
 * setupHeartbeat options; the ExtensionAPI is a plain handler registry.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStatus, setupHeartbeat, statusDir } from "../pi-status";

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
	const handlers: Record<string, Handler> = {};
	const pi = { on: (name: string, handler: Handler) => { handlers[name] = handler; } } as any;
	return { pi, handlers };
}

function readStatus(file: string) {
	return JSON.parse(readFileSync(file, "utf8"));
}

describe("statusDir", () => {
	it("prefers XDG_CACHE_HOME", () => {
		expect(statusDir({ XDG_CACHE_HOME: "/x/cache" } as any)).toBe("/x/cache/pi-status");
	});

	it("falls back to ~/.cache", () => {
		expect(statusDir({} as any)).toMatch(/\.cache\/pi-status$/);
	});
});

describe("computeStatus", () => {
	it("is working only while an agent runs with no question card up", () => {
		expect(computeStatus(true, 0)).toBe("working");
		expect(computeStatus(true, 1)).toBe("idle");
		expect(computeStatus(false, 0)).toBe("idle");
		expect(computeStatus(false, 1)).toBe("idle");
	});
});

describe("setupHeartbeat", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-status-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("tracks the session and agent lifecycle", async () => {
		const { pi, handlers } = fakePi();
		const { file } = setupHeartbeat(pi, { dir, pid: 424242, interactive: false });

		await handlers.session_start({}, { cwd: "/repo" });
		expect(readStatus(file)).toMatchObject({
			pid: 424242,
			cwd: "/repo",
			interactive: false,
			status: "idle",
		});

		await handlers.agent_start({}, { cwd: "/repo" });
		expect(readStatus(file).status).toBe("working");

		await handlers.agent_end({ messages: [] }, { cwd: "/repo" });
		expect(readStatus(file).status).toBe("idle");
	});

	it("treats a waiting question card as idle", async () => {
		const { pi, handlers } = fakePi();
		const { file } = setupHeartbeat(pi, { dir, pid: 424242, interactive: true });

		await handlers.agent_start({}, { cwd: "/repo" });
		await handlers.tool_execution_start({ toolName: "launch_qna" }, { cwd: "/repo" });
		expect(readStatus(file).status).toBe("idle");

		await handlers.tool_execution_end({ toolName: "launch_qna" }, { cwd: "/repo" });
		expect(readStatus(file).status).toBe("working");
	});

	it("ignores other tools", async () => {
		const { pi, handlers } = fakePi();
		const { file } = setupHeartbeat(pi, { dir, pid: 424242 });

		await handlers.agent_start({}, { cwd: "/repo" });
		await handlers.tool_execution_start({ toolName: "bash" }, { cwd: "/repo" });
		expect(readStatus(file).status).toBe("working");
	});

	it("follows cwd changes from event context", async () => {
		const { pi, handlers } = fakePi();
		const { file } = setupHeartbeat(pi, { dir, pid: 424242 });

		await handlers.session_start({}, { cwd: "/a" });
		await handlers.agent_start({}, { cwd: "/b" });
		expect(readStatus(file).cwd).toBe("/b");
	});

	it("removes the file on session_shutdown", async () => {
		const { pi, handlers } = fakePi();
		const { file } = setupHeartbeat(pi, { dir, pid: 424242 });

		await handlers.session_start({}, { cwd: "/repo" });
		expect(existsSync(file)).toBe(true);

		await handlers.session_shutdown({ reason: "quit" }, { cwd: "/repo" });
		expect(existsSync(file)).toBe(false);
	});
});
