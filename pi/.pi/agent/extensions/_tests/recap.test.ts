import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	buildTranscript,
	type Clock,
	CONFIG_FILE_NAME,
	clipMiddle,
	countTurnsSinceLastRecap,
	createRecapExtension,
	DEFAULT_CONFIG,
	formatMinutes,
	IdleTimer,
	loadConfig,
	parseConfig,
	RECAP_ENTRY_TYPE,
	type RecapConfig,
} from "../recap";

class FakeClock implements Clock {
	time = 1_000_000;
	private nextId = 1;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();

	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, ms: number): unknown {
		const id = this.nextId++;
		this.timers.set(id, { at: this.time + ms, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	get pending(): number {
		return this.timers.size;
	}

	advance(ms: number): void {
		const target = this.time + ms;
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			this.time = due[1].at;
			due[1].callback();
		}
		this.time = target;
	}
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function sessionWithTurns(turns: number): SessionManager {
	const session = SessionManager.inMemory("/tmp/pi-recap-test");
	for (let index = 0; index < turns; index++) {
		session.appendMessage({ role: "user", content: `question ${index}`, timestamp: Date.now() });
		session.appendMessage(assistant(`answer ${index}`));
	}
	return session;
}

describe("config", () => {
	it("keeps valid fields and reports invalid ones", () => {
		const { config, warnings } = parseConfig({
			idleMinutes: 10,
			minNewTurns: -1,
			model: "openai-codex/gpt-6-astra",
			enabled: "yes",
		});
		expect(config).toEqual({ idleMinutes: 10, model: "openai-codex/gpt-6-astra" });
		expect(warnings).toHaveLength(2);
	});

	it("rejects malformed model references", () => {
		expect(parseConfig({ model: "gpt-6" }).config.model).toBeUndefined();
	});

	it("merges file config over defaults and applies the env override", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-recap-"));
		writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ idleMinutes: 30, minNewTurns: 4 }));
		expect(loadConfig({ agentDir: dir, env: {} }).config).toEqual({
			...DEFAULT_CONFIG,
			idleMinutes: 30,
			minNewTurns: 4,
		});
		expect(loadConfig({ agentDir: dir, env: { PI_RECAP_IDLE_MINUTES: "0.1" } }).config.idleMinutes).toBe(0.1);
		expect(loadConfig({ agentDir: dir, env: { PI_RECAP_IDLE_MINUTES: "zero" } }).warnings).toHaveLength(1);
	});

	it("survives a malformed file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-recap-"));
		writeFileSync(join(dir, CONFIG_FILE_NAME), "{not json");
		const loaded = loadConfig({ agentDir: dir, env: {} });
		expect(loaded.config).toEqual(DEFAULT_CONFIG);
		expect(loaded.warnings).toHaveLength(1);
	});

	it("formats durations", () => {
		expect(formatMinutes(15)).toBe("15m");
		expect(formatMinutes(120)).toBe("2h");
		expect(formatMinutes(0.5)).toBe("30s");
	});
});

describe("IdleTimer", () => {
	it("fires once after the delay with the idle duration", () => {
		const clock = new FakeClock();
		const fired: number[] = [];
		const timer = new IdleTimer(clock, (ms) => fired.push(ms));
		timer.arm(1000);
		clock.advance(999);
		expect(fired).toEqual([]);
		clock.advance(1);
		expect(fired).toEqual([1000]);
		clock.advance(5000);
		expect(fired).toEqual([1000]);
		expect(timer.armed).toBe(false);
	});

	it("touch restarts only an armed timer", () => {
		const clock = new FakeClock();
		const fired: number[] = [];
		const timer = new IdleTimer(clock, (ms) => fired.push(ms));
		timer.touch(1000);
		expect(timer.armed).toBe(false);
		timer.arm(1000);
		clock.advance(800);
		timer.touch(1000);
		clock.advance(800);
		expect(fired).toEqual([]);
		clock.advance(200);
		expect(fired).toEqual([1000]);
	});

	it("cancel prevents firing", () => {
		const clock = new FakeClock();
		const timer = new IdleTimer(clock, () => {
			throw new Error("should not fire");
		});
		timer.arm(1000);
		timer.cancel();
		clock.advance(2000);
		expect(clock.pending).toBe(0);
	});
});

describe("transcript", () => {
	it("counts assistant turns since the last recap entry", () => {
		const session = sessionWithTurns(3);
		expect(countTurnsSinceLastRecap(session.getBranch())).toBe(3);
		session.appendCustomEntry(RECAP_ENTRY_TYPE, { markdown: "x" });
		expect(countTurnsSinceLastRecap(session.getBranch())).toBe(0);
		session.appendMessage({ role: "user", content: "more", timestamp: Date.now() });
		expect(countTurnsSinceLastRecap(session.getBranch())).toBe(0);
	});

	it("serializes the conversation and excludes recap entries", () => {
		const session = sessionWithTurns(2);
		session.appendCustomEntry(RECAP_ENTRY_TYPE, { markdown: "SECRET-RECAP-TEXT" });
		const text = buildTranscript(session.getEntries(), session.getLeafId(), 10_000);
		expect(text).toContain("question 0");
		expect(text).toContain("answer 1");
		expect(text).not.toContain("SECRET-RECAP-TEXT");
	});

	it("clips the middle while keeping the opening and recent activity", () => {
		const text = `GOAL${"x".repeat(5000)}LATEST`;
		const clipped = clipMiddle(text, 1000);
		expect(clipped.startsWith("GOAL")).toBe(true);
		expect(clipped.endsWith("LATEST")).toBe(true);
		expect(clipped).toContain("omitted");
		expect(clipMiddle("short", 1000)).toBe("short");
	});
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function setup(options: { config?: Partial<RecapConfig>; turns?: number } = {}) {
	const clock = new FakeClock();
	const session = sessionWithTurns(options.turns ?? 3);
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let terminalHandler: ((data: string) => unknown) | undefined;
	let idle = true;
	let resolveComplete: (() => void) | undefined;

	const appendEntry = vi.fn((customType: string, data: unknown) => {
		session.appendCustomEntry(customType, data);
	});
	const complete = vi.fn((_model: unknown, _context: unknown, opts: { signal: AbortSignal; reasoning?: string }) => ({
		result: () =>
			new Promise((resolve) => {
				resolveComplete = () =>
					resolve(opts.signal.aborted ? { ...assistant(""), stopReason: "aborted" } : assistant("**Goal**\n- test"));
			}),
	}));
	const notify = vi.fn();

	const model = { provider: "test", id: "test-model" };
	const ctx = {
		mode: "tui",
		hasUI: true,
		model,
		sessionManager: session,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		modelRegistry: { find: () => model, hasConfiguredAuth: () => true, streamSimple: complete },
		ui: {
			notify,
			setStatus: vi.fn(),
			onTerminalInput: (handler: (data: string) => unknown) => {
				terminalHandler = handler;
				return () => {
					terminalHandler = undefined;
				};
			},
		},
	};

	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, command),
		registerEntryRenderer: vi.fn(),
		appendEntry,
	};

	const config = { ...DEFAULT_CONFIG, ...options.config };
	createRecapExtension({ clock, loadConfig: () => ({ config, warnings: [] }) })(pi as never);

	const emit = async (event: string, payload: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
	};
	const flush = async () => {
		resolveComplete?.();
		resolveComplete = undefined;
		await new Promise((resolve) => setImmediate(resolve));
	};

	return {
		clock,
		session,
		complete,
		appendEntry,
		notify,
		emit,
		flush,
		ctx,
		commands,
		setIdle: (value: boolean) => {
			idle = value;
		},
		key: () => terminalHandler?.("a"),
	};
}

const MINUTE = 60_000;

describe("idle recap", () => {
	it("generates a recap after the configured idle time and appends it as a custom entry", async () => {
		const t = setup();
		await t.emit("session_start", { reason: "startup" });
		await t.emit("agent_settled");
		t.clock.advance(15 * MINUTE - 1);
		expect(t.complete).not.toHaveBeenCalled();
		t.clock.advance(1);
		expect(t.complete).toHaveBeenCalledTimes(1);
		await t.flush();
		expect(t.appendEntry).toHaveBeenCalledWith(
			RECAP_ENTRY_TYPE,
			expect.objectContaining({ markdown: "**Goal**\n- test", trigger: "idle", idleMs: 15 * MINUTE, model: "test/test-model" }),
		);
	});

	it("restarts the countdown on keystrokes", async () => {
		const t = setup();
		await t.emit("session_start", { reason: "startup" });
		await t.emit("agent_settled");
		t.clock.advance(10 * MINUTE);
		t.key();
		t.clock.advance(10 * MINUTE);
		expect(t.complete).not.toHaveBeenCalled();
		t.clock.advance(5 * MINUTE);
		expect(t.complete).toHaveBeenCalledTimes(1);
	});

	it("cancels the timer and an in-flight recap when the user submits input", async () => {
		const t = setup();
		await t.emit("session_start", { reason: "startup" });
		await t.emit("agent_settled");
		t.clock.advance(15 * MINUTE);
		expect(t.complete).toHaveBeenCalledTimes(1);
		await t.emit("input", { text: "next", source: "interactive" });
		await t.flush();
		expect(t.appendEntry).not.toHaveBeenCalled();

		await t.emit("agent_settled");
		await t.emit("input", { text: "again", source: "interactive" });
		t.clock.advance(60 * MINUTE);
		expect(t.complete).toHaveBeenCalledTimes(1);
	});

	it("skips sessions without enough new turns", async () => {
		const t = setup({ turns: 1 });
		await t.emit("session_start", { reason: "startup" });
		await t.emit("agent_settled");
		t.clock.advance(15 * MINUTE);
		expect(t.complete).not.toHaveBeenCalled();
	});

	it("does not recap twice without new activity", async () => {
		const t = setup();
		await t.emit("session_start", { reason: "startup" });
		await t.emit("agent_settled");
		t.clock.advance(15 * MINUTE);
		await t.flush();
		expect(t.appendEntry).toHaveBeenCalledTimes(1);
		await t.emit("agent_settled");
		t.clock.advance(15 * MINUTE);
		expect(t.complete).toHaveBeenCalledTimes(1);
	});

	it("discards a recap if the session moved on while it was generating", async () => {
		const t = setup();
		await t.emit("session_start", { reason: "startup" });
		await t.emit("agent_settled");
		t.clock.advance(15 * MINUTE);
		t.session.appendMessage(assistant("new work"));
		await t.flush();
		expect(t.appendEntry).not.toHaveBeenCalled();
	});

	it("does not fire while the agent is busy", async () => {
		const t = setup();
		await t.emit("session_start", { reason: "startup" });
		await t.emit("agent_settled");
		t.setIdle(false);
		t.clock.advance(15 * MINUTE);
		expect(t.complete).not.toHaveBeenCalled();
	});

	it("respects enabled: false but still supports /recap", async () => {
		const t = setup({ config: { enabled: false } });
		await t.emit("session_start", { reason: "startup" });
		await t.emit("agent_settled");
		t.clock.advance(60 * MINUTE);
		expect(t.complete).not.toHaveBeenCalled();

		const run = t.commands.get("recap")!.handler("", t.ctx);
		await t.flush();
		await run;
		expect(t.appendEntry).toHaveBeenCalledWith(RECAP_ENTRY_TYPE, expect.objectContaining({ trigger: "manual" }));
	});

	it("/recap off disables idle recaps for the session", async () => {
		const t = setup();
		await t.emit("session_start", { reason: "startup" });
		await t.commands.get("recap")!.handler("off", t.ctx);
		await t.emit("agent_settled");
		t.clock.advance(60 * MINUTE);
		expect(t.complete).not.toHaveBeenCalled();
	});

	it("cleans up on shutdown", async () => {
		const t = setup();
		await t.emit("session_start", { reason: "startup" });
		await t.emit("agent_settled");
		await t.emit("session_shutdown", { reason: "quit" });
		expect(t.clock.pending).toBe(0);
	});
});

describe("recap model call", () => {
	it("requests low reasoning effort", async () => {
		const t = setup();
		await t.emit("session_start", { reason: "startup" });
		await t.emit("agent_settled");
		t.clock.advance(15 * MINUTE);
		expect(t.complete.mock.calls[0]![2]).toMatchObject({ reasoning: "low", maxTokens: DEFAULT_CONFIG.maxOutputTokens });
	});
});
