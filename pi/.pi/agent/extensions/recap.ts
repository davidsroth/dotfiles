/**
 * recap.ts — `/recap` plus an automatic recap after a period of inactivity.
 *
 * The idle countdown starts when the agent fully settles, restarts on any
 * keystroke, and is cancelled by a submitted prompt. At most one recap fires per
 * idle period, and only when enough new assistant turns happened since the last
 * recap. Recaps are persisted as a custom session entry (rendered inline, never
 * sent to the model). A recap generated for a session that moved on meanwhile
 * is discarded.
 *
 * Config (all optional): ~/.pi/agent/recap.json
 *   { "enabled": true, "idleMinutes": 15, "minNewTurns": 2,
 *     "model": "provider/model-id", "maxTranscriptChars": 60000,
 *     "maxOutputTokens": 4000 }
 * `PI_RECAP_IDLE_MINUTES` overrides idleMinutes (handy for testing).
 *
 * Kept as a single self-contained file: the Windows bundle copies it alone.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildSessionContext,
	convertToLlm,
	getAgentDir,
	getMarkdownTheme,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const CONFIG_FILE_NAME = "recap.json";
export const IDLE_MINUTES_ENV = "PI_RECAP_IDLE_MINUTES";
const MAX_IDLE_MINUTES = 24 * 60;

export interface RecapConfig {
	/** Whether idle recaps fire automatically. `/recap` works either way. */
	enabled: boolean;
	/** Minutes of inactivity after the agent settles before a recap is generated. */
	idleMinutes: number;
	/** Minimum assistant turns since the previous recap before an idle recap fires. */
	minNewTurns: number;
	/** Optional "provider/model-id"; defaults to the session's current model. */
	model?: string;
	/** Transcript budget sent to the recap model, in characters. */
	maxTranscriptChars: number;
	/** Output token cap for the recap model call. */
	maxOutputTokens: number;
}

export const DEFAULT_CONFIG: RecapConfig = {
	enabled: true,
	idleMinutes: 15,
	minNewTurns: 2,
	maxTranscriptChars: 60_000,
	maxOutputTokens: 4_000,
};

const isPositiveNumber = (value: unknown, max: number): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;

const isIntegerInRange = (value: unknown, min: number, max: number): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** Validate a parsed config object, dropping invalid fields rather than failing. */
export function parseConfig(raw: unknown): { config: Partial<RecapConfig>; warnings: string[] } {
	const config: Partial<RecapConfig> = {};
	const warnings: string[] = [];
	if (raw === undefined) return { config, warnings };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { config, warnings: ["config must be a JSON object"] };
	}
	const input = raw as Record<string, unknown>;
	const field = <K extends keyof RecapConfig>(key: K, ok: boolean, describe: string) => {
		if (!(key in input)) return;
		if (ok) config[key] = input[key] as RecapConfig[K];
		else warnings.push(`${key} must be ${describe}; ignoring`);
	};
	field("enabled", typeof input.enabled === "boolean", "a boolean");
	field(
		"idleMinutes",
		isPositiveNumber(input.idleMinutes, MAX_IDLE_MINUTES),
		`a number in (0, ${MAX_IDLE_MINUTES}]`,
	);
	field("minNewTurns", isIntegerInRange(input.minNewTurns, 0, 1000), "a non-negative integer");
	field(
		"model",
		typeof input.model === "string" && /^[^/\s]+\/\S+$/.test(input.model),
		'a "provider/model-id" string',
	);
	field(
		"maxTranscriptChars",
		isIntegerInRange(input.maxTranscriptChars, 1000, 2_000_000),
		"an integer >= 1000",
	);
	field("maxOutputTokens", isIntegerInRange(input.maxOutputTokens, 256, 128_000), "an integer >= 256");
	return { config, warnings };
}

export function loadConfig(
	options: { agentDir?: string; env?: NodeJS.ProcessEnv } = {},
): { config: RecapConfig; warnings: string[] } {
	const path = join(options.agentDir ?? getAgentDir(), CONFIG_FILE_NAME);
	const warnings: string[] = [];
	let fileConfig: Partial<RecapConfig> = {};
	if (existsSync(path)) {
		try {
			const parsed = parseConfig(JSON.parse(readFileSync(path, "utf8")));
			fileConfig = parsed.config;
			warnings.push(...parsed.warnings.map((warning) => `${path}: ${warning}`));
		} catch (error) {
			warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const config: RecapConfig = { ...DEFAULT_CONFIG, ...fileConfig };
	const envValue = (options.env ?? process.env)[IDLE_MINUTES_ENV];
	if (envValue !== undefined && envValue !== "") {
		const minutes = Number(envValue);
		if (isPositiveNumber(minutes, MAX_IDLE_MINUTES)) config.idleMinutes = minutes;
		else warnings.push(`${IDLE_MINUTES_ENV} must be a number in (0, ${MAX_IDLE_MINUTES}]; ignoring`);
	}
	return { config, warnings };
}

export function formatMinutes(minutes: number): string {
	if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
	if (minutes < 1) return `${Math.round(minutes * 60)}s`;
	return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
}

// ---------------------------------------------------------------------------
// Idle timer
// ---------------------------------------------------------------------------

export interface Clock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => {
		const handle = setTimeout(callback, ms);
		// An idle recap must never keep Pi alive.
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One-shot inactivity timer. `arm` starts an idle period; `touch` restarts the
 * countdown only while armed (user presence without a new agent run); `cancel`
 * ends the idle period. The callback receives the idle duration in ms.
 */
export class IdleTimer {
	private handle: unknown;
	private idleSince: number | undefined;
	private deadline: number | undefined;

	constructor(
		private readonly clock: Clock,
		private readonly onIdle: (idleMs: number) => void,
	) {}

	arm(delayMs: number): void {
		this.clear();
		this.idleSince = this.clock.now();
		this.schedule(delayMs);
	}

	touch(delayMs: number): void {
		if (this.deadline === undefined) return;
		this.arm(delayMs);
	}

	cancel(): void {
		this.clear();
		this.idleSince = undefined;
	}

	get armed(): boolean {
		return this.deadline !== undefined;
	}

	/** Epoch ms when the timer will fire, if armed. */
	get firesAt(): number | undefined {
		return this.deadline;
	}

	private schedule(delayMs: number): void {
		this.deadline = this.clock.now() + delayMs;
		this.handle = this.clock.setTimeout(() => {
			const idleMs = this.clock.now() - (this.idleSince ?? this.clock.now());
			this.handle = undefined;
			this.deadline = undefined;
			this.idleSince = undefined;
			this.onIdle(idleMs);
		}, delayMs);
	}

	private clear(): void {
		if (this.handle !== undefined) this.clock.clearTimeout(this.handle);
		this.handle = undefined;
		this.deadline = undefined;
	}
}

// ---------------------------------------------------------------------------
// Transcript and prompt
// ---------------------------------------------------------------------------

export const RECAP_ENTRY_TYPE = "recap";

export interface RecapEntryData {
	markdown: string;
	createdAt: number;
	trigger: "idle" | "manual";
	/** Idle time before generation started, in ms (idle trigger only). */
	idleMs?: number;
	model: string;
	/** Session leaf the recap describes. */
	throughEntryId: string | null;
}

const isRecapEntry = (entry: SessionEntry): boolean =>
	entry.type === "custom" && entry.customType === RECAP_ENTRY_TYPE;

/** Assistant turns on the active branch since the most recent recap (or session start). */
export function countTurnsSinceLastRecap(branch: readonly SessionEntry[]): number {
	let count = 0;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (isRecapEntry(entry)) break;
		if (entry.type === "message" && entry.message.role === "assistant") count++;
	}
	return count;
}

/** Keep the opening (usually the goal) and the most recent activity within a character budget. */
export function clipMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.2);
	const tail = maxChars - head;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n\n[… ${omitted} characters of earlier conversation omitted …]\n\n${text.slice(-tail)}`;
}

/** Serialize the compaction-aware model context of the given leaf. */
export function buildTranscript(entries: SessionEntry[], leafId: string | null, maxChars: number): string {
	const messages = buildSessionContext(entries, leafId).messages.filter(
		(message) => message.role !== "system",
	);
	return clipMiddle(serializeConversation(convertToLlm(messages)).trim(), maxChars);
}

export const RECAP_SYSTEM_PROMPT = `You write a short recap for a user returning to a coding-agent session after time away. The recap must let them resume in under a minute.

Rules:
- Do NOT continue the conversation, answer questions in it, or give new advice. Only recap.
- Base every statement on the transcript. If something is unclear, say so briefly instead of guessing.
- Weight recent activity most; mention earlier work only as context for the current state.
- Be concrete: name files, commands, branches, decisions, and errors.
- Output Markdown with these bold labels, each followed by 1-3 terse bullets. Omit a section when it has nothing real to say:
  **Waiting on you** — questions, approvals, or decisions the assistant asked the user for. Always first when present.
  **Goal** — what the user is trying to accomplish.
  **Done** — what was completed or decided.
  **State** — where things stand right now, including anything half-finished or failing.
  **Next** — the most sensible next step.
- Stay under 150 words. No preamble or closing line.`;

export function buildRecapUserPrompt(transcript: string, awayMinutes: number | undefined): string {
	const away =
		awayMinutes === undefined
			? "The user asked for a recap of this session."
			: `The user has been away for about ${Math.max(1, Math.round(awayMinutes))} minutes.`;
	return `<conversation>\n${transcript}\n</conversation>\n\n${away} Write the recap.`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const STATUS_KEY = "recap";

export interface RecapDeps {
	clock?: Clock;
	loadConfig?: () => { config: RecapConfig; warnings: string[] };
}

function resolveModel(ctx: ExtensionContext, config: RecapConfig): { model?: Model<Api>; error?: string } {
	if (config.model) {
		const slash = config.model.indexOf("/");
		const model = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
		return model ? { model } : { error: `recap model ${config.model} not found` };
	}
	return ctx.model ? { model: ctx.model } : { error: "no model selected" };
}

export function createRecapExtension(deps: RecapDeps = {}) {
	const clock = deps.clock ?? systemClock;
	const load = deps.loadConfig ?? (() => loadConfig());

	return function recapExtension(pi: ExtensionAPI): void {
		let config: RecapConfig = DEFAULT_CONFIG;
		let autoEnabled = config.enabled;
		let latestCtx: ExtensionContext | undefined;
		let inFlight: AbortController | undefined;
		let unsubscribeTerminal: (() => void) | undefined;

		const idleDelayMs = () => config.idleMinutes * 60_000;
		const abortInFlight = () => {
			inFlight?.abort();
			inFlight = undefined;
		};

		const timer = new IdleTimer(clock, (idleMs) => {
			const ctx = latestCtx;
			if (!ctx || !autoEnabled || !ctx.isIdle() || ctx.hasPendingMessages()) return;
			const turns = countTurnsSinceLastRecap(ctx.sessionManager.getBranch());
			if (turns === 0 || turns < config.minNewTurns) return;
			void generate(ctx, "idle", idleMs);
		});

		async function generate(
			ctx: ExtensionContext,
			trigger: RecapEntryData["trigger"],
			idleMs?: number,
		): Promise<void> {
			const warn = (message: string) => {
				if (ctx.hasUI) ctx.ui.notify(`Recap: ${message}`, "warning");
			};
			const { model, error } = resolveModel(ctx, config);
			if (!model) return warn(error ?? "no model");
			if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
				return warn(`no credentials configured for ${model.provider}/${model.id}`);
			}

			const leafAtStart = ctx.sessionManager.getLeafId();
			const transcript = buildTranscript(ctx.sessionManager.getEntries(), leafAtStart, config.maxTranscriptChars);
			if (!transcript) {
				if (trigger === "manual") warn("nothing to recap yet");
				return;
			}

			abortInFlight();
			const controller = new AbortController();
			inFlight = controller;
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "recap…");
			try {
				const response = await ctx.modelRegistry
					.streamSimple(
						model,
						{
							systemPrompt: RECAP_SYSTEM_PROMPT,
							messages: [
								{
									role: "user",
									content: [
										{
											type: "text",
											text: buildRecapUserPrompt(transcript, idleMs === undefined ? undefined : idleMs / 60_000),
										},
									],
									timestamp: clock.now(),
								},
							],
						},
						{
							signal: controller.signal,
							reasoning: "low",
							maxTokens: config.maxOutputTokens,
							cacheRetention: "none",
							sessionId: randomUUID(),
						},
					)
					.result();
				if (controller.signal.aborted || response.stopReason === "aborted") return;
				if (response.stopReason === "error") return warn(response.errorMessage ?? "model call failed");
				const markdown = response.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("\n")
					.trim();
				if (!markdown) return warn("model returned an empty recap");
				// Drop a stale idle recap if the session moved on while it was generating.
				if (trigger === "idle" && (ctx.sessionManager.getLeafId() !== leafAtStart || !ctx.isIdle())) return;
				pi.appendEntry<RecapEntryData>(RECAP_ENTRY_TYPE, {
					markdown,
					createdAt: clock.now(),
					trigger,
					...(idleMs === undefined ? {} : { idleMs }),
					model: `${model.provider}/${model.id}`,
					throughEntryId: leafAtStart,
				});
			} catch (err) {
				if (!controller.signal.aborted) warn(err instanceof Error ? err.message : String(err));
			} finally {
				if (inFlight === controller) inFlight = undefined;
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		}

		pi.registerEntryRenderer<RecapEntryData>(RECAP_ENTRY_TYPE, (entry, _options, theme) => {
			const data = entry.data;
			if (!data?.markdown) return undefined;
			const when = new Date(data.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			const reason =
				data.trigger === "idle" && data.idleMs !== undefined
					? `after ${formatMinutes(data.idleMs / 60_000)} idle`
					: "on request";
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(
				new Text(
					`${theme.fg("customMessageLabel", theme.bold("Recap"))}${theme.fg("dim", ` · ${reason} · ${when} · ${data.model}`)}`,
					0,
					0,
				),
			);
			box.addChild(new Text("", 0, 0));
			box.addChild(new Markdown(data.markdown, 0, 0, getMarkdownTheme()));
			return box;
		});

		pi.registerCommand("recap", {
			description: "Recap this session now, or `/recap on|off|status`",
			getArgumentCompletions: (prefix) =>
				["on", "off", "status"]
					.filter((value) => value.startsWith(prefix.trim()))
					.map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				latestCtx = ctx;
				const command = args.trim().toLowerCase();
				if (command === "on" || command === "off") {
					autoEnabled = command === "on";
					if (!autoEnabled) timer.cancel();
					ctx.ui.notify(`Idle recaps ${autoEnabled ? "on" : "off"} for this session`, "info");
					return;
				}
				if (command === "status") {
					const firesAt = timer.firesAt;
					ctx.ui.notify(
						[
							`Idle recaps ${autoEnabled ? "on" : "off"}: after ${formatMinutes(config.idleMinutes)} idle, ≥${config.minNewTurns} new turns`,
							`Model: ${config.model ?? "session model"} · ${firesAt ? `next check at ${new Date(firesAt).toLocaleTimeString()}` : "not armed"}`,
							`Turns since last recap: ${countTurnsSinceLastRecap(ctx.sessionManager.getBranch())}`,
						].join("\n"),
						"info",
					);
					return;
				}
				if (command) {
					ctx.ui.notify("Usage: /recap [on|off|status]", "warning");
					return;
				}
				if (!ctx.isIdle()) {
					ctx.ui.notify("Recap: wait until the agent is idle", "warning");
					return;
				}
				timer.cancel();
				await generate(ctx, "manual");
			},
		});

		pi.on("session_start", (_event, ctx) => {
			const loaded = load();
			config = loaded.config;
			autoEnabled = config.enabled;
			latestCtx = ctx;
			timer.cancel();
			abortInFlight();
			if (ctx.hasUI) for (const warning of loaded.warnings) ctx.ui.notify(`recap: ${warning}`, "warning");
			unsubscribeTerminal?.();
			unsubscribeTerminal = undefined;
			if (ctx.mode === "tui") {
				// Any keystroke while idle means the user is present: restart the countdown.
				unsubscribeTerminal = ctx.ui.onTerminalInput(() => {
					if (timer.armed) timer.touch(idleDelayMs());
					return undefined;
				});
			}
		});

		pi.on("agent_start", () => {
			timer.cancel();
			abortInFlight();
		});

		pi.on("input", (event) => {
			if (event.source === "extension") return;
			timer.cancel();
			abortInFlight();
		});

		pi.on("agent_settled", (_event, ctx) => {
			latestCtx = ctx;
			if (autoEnabled && ctx.hasUI) timer.arm(idleDelayMs());
		});

		pi.on("session_shutdown", () => {
			timer.cancel();
			abortInFlight();
			unsubscribeTerminal?.();
			unsubscribeTerminal = undefined;
			latestCtx = undefined;
		});
	};
}

export default createRecapExtension();
