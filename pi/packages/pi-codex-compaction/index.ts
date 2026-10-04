import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildSessionContext, sessionEntryToContextMessages, VERSION, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { loadCompactionConfig } from "./config.ts";
import {
	buildCodexHeaders,
	buildCompactionRequestBody,
	buildReplacementHistory,
	buildToolPayload,
	callRemoteCompaction,
	effectiveInputForBranch,
	entriesToResponseItems,
	findNativeCheckpoint,
	isJsonObject,
	isOpenAICodexModel,
	mergeFeatureHeader,
	modelKey,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
	resolveCodexResponsesUrl,
	stripInputFromPayload,
	type JsonObject,
	type NativeCompactionDetails,
	type ResponseItem,
} from "./native-compaction.ts";

type CachedPayloadShape = {
	modelKey: string;
	payload: JsonObject;
	input?: ResponseItem[];
	leafId: string | null;
};

type CompactionStatus = {
	state: "running" | "complete" | "failed";
	error?: string;
};

type LegacyCompactionState = {
	sessionId: string;
	phase: "armed" | "compacting" | "compacted";
	interrupted: boolean;
};

const COMPACTION_STATUS_KIND = "openai-codex-compaction-status";
const COMPACTION_BOUNDARY_KIND = "openai-codex-compaction-boundary";

function checkpointError(branch: SessionEntry[], model: Model<any> | undefined): string | undefined {
	const checkpoint = findNativeCheckpoint(branch);
	if (checkpoint.status === "none") return;
	if (checkpoint.status === "invalid") return "The native Codex checkpoint is malformed. Fork before the checkpoint to recover.";
	if (!model || !isOpenAICodexModel(model) || checkpoint.checkpoint.details.modelKey !== modelKey(model)) {
		return `This branch requires ${checkpoint.checkpoint.details.modelKey}. Switch back to that exact model, or fork before the native checkpoint. No portable text summary exists.`;
	}
}

function blockRequest(ctx: ExtensionContext, reason: string): void {
	// Throwing alone is not sufficient: Pi catches extension-handler errors.
	void ctx.abort();
	if (ctx.hasUI) ctx.ui.notify(`OpenAI Codex request blocked: ${reason}`, "error");
	else console.error(`OpenAI Codex request blocked: ${reason}`);
}

function sameContextExceptText(left: unknown[], right: unknown[]): boolean {
	const normalize = (message: unknown): unknown => {
		if (!isJsonObject(message)) return message;
		const content = message.content;
		if (typeof content === "string") return { ...message, content: "" };
		if (!Array.isArray(content)) return message;
		return {
			...message,
			content: content.map((part) => isJsonObject(part) && part.type === "text"
				? { ...part, text: "" }
				: part),
		};
	};
	return left.length === right.length && isDeepStrictEqual(left.map(normalize), right.map(normalize));
}
const PI_MID_RUN_COMPACTION_MIN_VERSION = "0.84.4";
const CONTINUATION_PROMPT = "Compaction completed. Continue.";

function parseVersion(version: string): [number, number, number] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function needsLegacyCompactionFallback(hostVersion: string): boolean {
	const host = parseVersion(hostVersion);
	const fixed = parseVersion(PI_MID_RUN_COMPACTION_MIN_VERSION);
	if (!host || !fixed) return false;
	for (let index = 0; index < host.length; index++) {
		if (host[index]! !== fixed[index]!) return host[index]! < fixed[index]!;
	}
	return false;
}

function localMarker(): string {
	return `OpenAI Codex native compaction checkpoint (${randomUUID()}).`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function effectiveBaseUrl(model: Model<any>): string | undefined {
	return model.baseUrl;
}

function setFeatureHeader(headers: Record<string, string | null>): void {
	const existing = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-codex-beta-features");
	if (existing) {
		headers[existing[0]] = mergeFeatureHeader(existing[1]);
	} else {
		headers["x-codex-beta-features"] = mergeFeatureHeader(undefined);
	}
}

export function registerCodexCompactionExtension(pi: ExtensionAPI, hostVersion = VERSION): void {
	const payloadShapeBySession = new Map<string, CachedPayloadShape>();
	const useLegacyFallback = needsLegacyCompactionFallback(hostVersion);
	let legacyCompaction: LegacyCompactionState | undefined;

	pi.registerEntryRenderer<CompactionStatus>(COMPACTION_STATUS_KIND, (entry, _options, theme) => {
		const data = entry.data;
		if (data?.state === "running") {
			return new Text(theme.fg("accent", "◐ OpenAI compaction running…"), 0, 0);
		}
		if (data?.state === "complete") {
			return new Text(theme.fg("success", "✓ OpenAI compaction complete"), 0, 0);
		}
		const suffix = data?.error ? `: ${data.error}` : "";
		return new Text(theme.fg("error", `✗ OpenAI compaction failed${suffix}`), 0, 0);
	});

	const appendCompactionStatus = (ctx: ExtensionContext, status: CompactionStatus): void => {
		if (ctx.mode === "tui") pi.appendEntry(COMPACTION_STATUS_KIND, status);
	};

	const withCompactionStatus = async <T>(
		ctx: ExtensionContext,
		operation: () => Promise<T>,
	): Promise<T> => {
		appendCompactionStatus(ctx, { state: "running" });
		try {
			const result = await operation();
			appendCompactionStatus(ctx, { state: "complete" });
			return result;
		} catch (error) {
			appendCompactionStatus(ctx, { state: "failed", error: errorMessage(error) });
			throw error;
		}
	};

	const createNativeCheckpoint = async (params: {
		ctx: ExtensionContext;
		model: Model<any>;
		input: ResponseItem[];
		basePayload?: JsonObject;
		signal?: AbortSignal;
	}): Promise<{ details: NativeCompactionDetails; usage?: Awaited<ReturnType<typeof callRemoteCompaction>>["usage"] }> => {
		const auth = await params.ctx.modelRegistry.getApiKeyAndHeaders(params.model);
		if (!auth.ok || !auth.apiKey) {
			throw new Error(auth.ok ? "OpenAI Codex authentication is unavailable." : auth.error);
		}
		const sessionId = params.ctx.sessionManager.getSessionId();
		const allTools = pi.getAllTools();
		const body = buildCompactionRequestBody({
			basePayload: params.basePayload,
			model: params.model,
			input: params.input,
			instructions: params.ctx.getSystemPrompt(),
			tools: buildToolPayload(allTools, pi.getActiveTools()),
			sessionId,
		});
		const remote = await callRemoteCompaction({
			url: resolveCodexResponsesUrl(effectiveBaseUrl(params.model)),
			headers: buildCodexHeaders({
				apiKey: auth.apiKey,
				headers: Object.fromEntries(Object.entries(auth.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null)),
				sessionId,
			}),
			body,
			model: params.model,
			signal: params.signal,
			timeoutSeconds: loadCompactionConfig(params.ctx.cwd, params.ctx.isProjectTrusted()).timeoutSeconds,
		});
		return {
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				modelKey: modelKey(params.model),
				replacementHistory: buildReplacementHistory(params.input, remote.compactionItem),
			},
			usage: remote.usage,
		};
	};

	pi.on("session_start", () => {
		payloadShapeBySession.clear();
		legacyCompaction = undefined;
	});
	pi.on("session_shutdown", () => {
		payloadShapeBySession.clear();
		legacyCompaction = undefined;
	});
	pi.on("session_tree", () => payloadShapeBySession.clear());
	pi.on("model_select", (_event, ctx) => {
		payloadShapeBySession.delete(ctx.sessionManager.getSessionId());
		legacyCompaction = undefined;
	});

	pi.on("context", (event, ctx) => {
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		const error = checkpointError(branch, ctx.model);
		if (error) {
			blockRequest(ctx, error);
			return { messages: [] };
		}
		const checkpoint = findNativeCheckpoint(branch);
		if (checkpoint.status !== "valid") return;
		// Older upstream checkpoints kept a Pi text tail already covered by the
		// opaque checkpoint. Remove only the structurally matched prefix, never rebuild
		// the live tail from the session log (that bypasses context transforms).
		const covered = buildSessionContext(branch.slice(0, checkpoint.checkpoint.entryIndex + 1)).messages;
		const summaryIndex = event.messages.findIndex((message) => message.role === "compactionSummary");
		if (summaryIndex < 0) return;
		// Pi 0.87+ projects a system checkpoint BEFORE the summary, but excludes
		// system messages from this context hook. Anchor both sides at the summary
		// instead of assuming it is the first reconstructed message.
		const coveredSummaryIndex = covered.findIndex((message) => message.role === "compactionSummary");
		const kept = covered.slice(coveredSummaryIndex + 1);
		if (coveredSummaryIndex < 0 || !sameContextExceptText(event.messages.slice(summaryIndex + 1, summaryIndex + 1 + kept.length), kept)) {
			blockRequest(ctx, "Cannot safely identify the checkpoint's retained prefix after context transformation.");
			return { messages: [] };
		}
		return { messages: [
			...event.messages.slice(0, summaryIndex),
			...event.messages.slice(summaryIndex + 1 + kept.length),
		] };
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isOpenAICodexModel(ctx.model)) return;
		setFeatureHeader(event.headers);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const model = ctx.model;
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		const error = checkpointError(branch, model);
		if (error) {
			blockRequest(ctx, error);
			return { ...(isJsonObject(event.payload) ? event.payload : {}), input: [], messages: [], previous_response_id: undefined };
		}
		if (!isOpenAICodexModel(model) || !isJsonObject(event.payload)) return undefined;

		const sessionId = ctx.sessionManager.getSessionId();
		const legacyState = legacyCompaction;
		if (useLegacyFallback && legacyState?.phase === "armed" && legacyState.sessionId === sessionId) {
			if (!legacyState.interrupted) {
				legacyCompaction = { ...legacyState, interrupted: true };
				if (ctx.hasUI) {
					ctx.ui.notify("Stopping before the next OpenAI Codex request to compact context.", "warning");
				}
			}
			ctx.abort();
		}

		const basePayload = stripInputFromPayload(event.payload);
		const cached: CachedPayloadShape = {
			modelKey: modelKey(model), payload: basePayload,
			leafId: ctx.sessionManager.getLeafId(),
			input: Array.isArray(event.payload.input) ? structuredClone(event.payload.input) : undefined,
		};
		payloadShapeBySession.set(sessionId, cached);

		const checkpoint = findNativeCheckpoint(branch);

		try {
			if (checkpoint.status !== "valid") return undefined;
			if (!Array.isArray(event.payload.input)) throw new Error("Expected a Responses input array for native checkpoint replay.");
			const checkpointEntry = branch[checkpoint.checkpoint.entryIndex];
			if (checkpointEntry.type === "compaction" && JSON.stringify(event.payload.input).includes(checkpointEntry.summary)) {
				throw new Error("The local checkpoint marker was not removed from provider context.");
			}
			const input = [...structuredClone(checkpoint.checkpoint.details.replacementHistory), ...event.payload.input];
			cached.input = structuredClone(input);
			const payload: JsonObject = { ...event.payload, input };
			delete payload.messages;
			delete payload.previous_response_id;
			return payload;
		} catch (error) {
			payloadShapeBySession.delete(sessionId);
			blockRequest(ctx, errorMessage(error));
			const payload: JsonObject = { ...event.payload, input: [] };
			delete payload.messages;
			delete payload.previous_response_id;
			return payload;
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		const guardError = checkpointError(event.branchEntries as SessionEntry[], model);
		if (guardError) {
			if (ctx.hasUI) ctx.ui.notify(guardError, "error");
			else console.error(guardError);
			return { cancel: true };
		}
		if (!isOpenAICodexModel(model)) return undefined;
		if (event.customInstructions?.trim()) {
			if (ctx.hasUI) ctx.ui.notify("Codex native compaction does not support custom summary instructions. Use /compact without a prompt.", "error");
			return { cancel: true };
		}

		try {
			const sessionId = ctx.sessionManager.getSessionId();
			const branch = event.branchEntries as SessionEntry[];
			const cached = payloadShapeBySession.get(sessionId);
			const cachedIndex = cached?.leafId ? branch.findIndex((entry) => entry.id === cached.leafId) : -1;
			const checkpoint = findNativeCheckpoint(branch);
			const checkpointIndex = checkpoint.status === "valid" ? checkpoint.checkpoint.entryIndex : -1;
			const canReuseInput = cached?.modelKey === modelKey(model) && cached.input && cachedIndex >= checkpointIndex && cachedIndex >= 0;
			let tail = branch.slice(cachedIndex + 1);
			if (event.reason === "overflow" && event.willRetry) {
				const lastAssistant = tail.findLastIndex((entry) => entry.type === "message" && entry.message.role === "assistant");
				tail = tail.filter((_entry, index) => index !== lastAssistant);
			}
			// Reuse the already transformed provider prefix whenever available.
			// Only newly finalized messages require local conversion. After a
			// restart (no observed request), reconstruct from the active branch.
			const input = canReuseInput
				? [...structuredClone(cached.input!), ...entriesToResponseItems(model, tail, pi.getAllTools())]
				: effectiveInputForBranch({
					branch, model, tools: pi.getAllTools(),
					excludeLastAssistantError: event.reason === "overflow" && event.willRetry,
				});
			const native = await withCompactionStatus(ctx, async () => {
				const result = await createNativeCheckpoint({
					ctx, model, input,
					basePayload: cached?.modelKey === modelKey(model) ? cached.payload : undefined,
					signal: event.signal,
				});
				// Never swallow messages appended while the remote request was pending,
				// or commit a checkpoint onto a branch that changed in the meantime.
				const currentBranch = ctx.sessionManager.getBranch();
				if (!branch.every((entry, index) => currentBranch[index]?.id === entry.id)
					|| currentBranch.slice(branch.length).some((entry) => sessionEntryToContextMessages(entry).length > 0)) {
					throw new Error("Session context changed during native compaction; retry compaction.");
				}
				event.signal.throwIfAborted();
				return result;
			});
			// All current messages are represented by the checkpoint. A real,
			// non-message boundary keeps Pi from retaining that history twice.
			event.signal.throwIfAborted();
			pi.appendEntry(COMPACTION_BOUNDARY_KIND, {});
			const firstKeptEntryId = ctx.sessionManager.getLeafId();
			if (!firstKeptEntryId) throw new Error("Could not persist native compaction boundary.");
			return {
				compaction: {
					summary: localMarker(),
					firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: native.usage,
					details: native.details,
				},
			};
		} catch (error) {
			if (legacyCompaction?.sessionId === ctx.sessionManager.getSessionId()) {
				legacyCompaction = undefined;
			}
			if (!event.signal.aborted) {
				const message = `OpenAI Codex native compaction failed: ${errorMessage(error)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else console.error(message);
			}
			return { cancel: true };
		}
	});

	if (!useLegacyFallback) return;

	const continueAfterCompaction = (ctx: ExtensionContext, expected: LegacyCompactionState): void => {
		if (legacyCompaction !== expected) return;
		legacyCompaction = undefined;
		if (!expected.interrupted || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		pi.sendUserMessage(CONTINUATION_PROMPT);
	};

	pi.on("turn_end", (_event, ctx) => {
		if (legacyCompaction || !isOpenAICodexModel(ctx.model)) return;
		const config = loadCompactionConfig(ctx.cwd, ctx.isProjectTrusted());
		if (!config.autoCompact) return;

		const usage = ctx.getContextUsage();
		if (usage?.percent === null || usage?.percent === undefined) return;
		if (usage.percent < config.thresholdRatio * 100) return;

		legacyCompaction = {
			sessionId: ctx.sessionManager.getSessionId(),
			phase: "armed",
			interrupted: false,
		};
	});

	pi.on("session_compact", (event, ctx) => {
		const state = legacyCompaction;
		const details = event.compactionEntry.details;
		if (
			!state
			|| state.phase !== "armed"
			|| state.sessionId !== ctx.sessionManager.getSessionId()
			|| event.reason === "manual"
			|| !event.fromExtension
			|| !isOpenAICodexModel(ctx.model)
			|| !isJsonObject(details)
			|| details.kind !== NATIVE_COMPACTION_KIND
		) {
			return;
		}
		if (event.willRetry) {
			legacyCompaction = undefined;
			return;
		}
		legacyCompaction = { ...state, phase: "compacted" };
	});

	pi.on("agent_settled", (_event, ctx) => {
		const state = legacyCompaction;
		if (
			!state
			|| state.sessionId !== ctx.sessionManager.getSessionId()
			|| !isOpenAICodexModel(ctx.model)
		) {
			return;
		}
		if (state.phase === "compacted") {
			continueAfterCompaction(ctx, state);
			return;
		}
		if (state.phase !== "armed") return;

		const compacting: LegacyCompactionState = { ...state, phase: "compacting" };
		legacyCompaction = compacting;
		ctx.compact({
			onComplete: () => continueAfterCompaction(ctx, compacting),
			onError: (error) => {
				if (legacyCompaction !== compacting) return;
				legacyCompaction = undefined;
				if (ctx.hasUI) {
					ctx.ui.notify(`OpenAI Codex compaction failed: ${error.message}`, "error");
				}
			},
		});
	});
}

export default function codexCompactionExtension(pi: ExtensionAPI): void {
	registerCodexCompactionExtension(pi);
}
