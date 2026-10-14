/**
 * Pure helpers for session-remote: wire-protocol validation, transcript
 * summarisation, and target resolution. No pi or intercom imports so the
 * module is unit-testable in isolation.
 */

export const NAMESPACE = "session-remote/v1";
/** Mirrors pi-intercom's extension-api.ts (not importable from a dotfiles extension). */
export const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";

const SNIPPET_CHARS = 280;
const RECENT_PROMPTS = 3;
const MAX_NAME_CHARS = 120;

export interface SessionDescription {
	piSessionId: string;
	name: string | null;
	cwd: string;
	sessionFile: string | null;
	mode: string;
	idle: boolean;
	messageCount: number;
	firstPrompt: string | null;
	recentPrompts: string[];
	lastReply: string | null;
}

export type WireMessage =
	| { kind: "describe"; requestId: string }
	| { kind: "describe_result"; requestId: string; info: SessionDescription }
	| { kind: "rename"; requestId: string; targetSessionId: string; name: string; by: string }
	| {
			kind: "rename_result";
			requestId: string;
			ok: boolean;
			previous: string | null;
			current: string | null;
			error?: string;
	  };

/** A description plus the broker-side identity it arrived from. */
export interface Peer extends SessionDescription {
	brokerId: string;
	self: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string";

function isDescription(v: unknown): v is SessionDescription {
	return (
		isObj(v) &&
		isStr(v.piSessionId) &&
		(v.name === null || isStr(v.name)) &&
		isStr(v.cwd) &&
		(v.sessionFile === null || isStr(v.sessionFile)) &&
		isStr(v.mode) &&
		typeof v.idle === "boolean" &&
		typeof v.messageCount === "number" &&
		(v.firstPrompt === null || isStr(v.firstPrompt)) &&
		Array.isArray(v.recentPrompts) &&
		v.recentPrompts.every(isStr) &&
		(v.lastReply === null || isStr(v.lastReply))
	);
}

/** Validate an untrusted broker payload; returns undefined for anything malformed. */
export function parseWireMessage(payload: unknown): WireMessage | undefined {
	if (!isObj(payload) || !isStr(payload.requestId)) return undefined;
	switch (payload.kind) {
		case "describe":
			return { kind: "describe", requestId: payload.requestId };
		case "describe_result":
			return isDescription(payload.info) ? (payload as WireMessage) : undefined;
		case "rename":
			return isStr(payload.targetSessionId) && isStr(payload.name) && isStr(payload.by)
				? (payload as WireMessage)
				: undefined;
		case "rename_result":
			return typeof payload.ok === "boolean" ? (payload as WireMessage) : undefined;
		default:
			return undefined;
	}
}

export function normalizeName(raw: string): string | undefined {
	const name = raw.replace(/\s+/g, " ").trim();
	if (!name) return undefined;
	return name.length > MAX_NAME_CHARS ? name.slice(0, MAX_NAME_CHARS).trimEnd() : name;
}

export function snippet(text: string, max = SNIPPET_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function textOf(content: unknown): string {
	if (isStr(content)) return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => isObj(part) && part.type === "text" && isStr(part.text))
		.map((part) => (part as { text: string }).text)
		.join("\n");
}

/** Summarise the active branch: first/recent user prompts and the latest assistant text. */
export function summarizeEntries(entries: readonly unknown[]): {
	messageCount: number;
	firstPrompt: string | null;
	recentPrompts: string[];
	lastReply: string | null;
} {
	const prompts: string[] = [];
	let lastReply: string | null = null;
	let messageCount = 0;
	for (const entry of entries) {
		if (!isObj(entry) || entry.type !== "message" || !isObj(entry.message)) continue;
		const { role, content } = entry.message;
		if (role !== "user" && role !== "assistant") continue;
		messageCount++;
		const text = textOf(content).trim();
		if (!text) continue;
		if (role === "user") prompts.push(snippet(text));
		else lastReply = snippet(text);
	}
	return {
		messageCount,
		firstPrompt: prompts[0] ?? null,
		recentPrompts: prompts.slice(1).slice(-RECENT_PROMPTS),
		lastReply,
	};
}

export type Resolution = { ok: true; peer: Peer } | { ok: false; error: string; candidates: Peer[] };

/**
 * Resolve a user-supplied target against responding peers. Exact matches on
 * broker id, pi session id, or (case-insensitive) name win; otherwise a
 * unique id prefix (>= 4 chars) or unique name substring is accepted.
 */
export function resolveTarget(peers: readonly Peer[], query: string): Resolution {
	const q = query.trim();
	const lower = q.toLowerCase();
	if (!q) return { ok: false, error: "Empty target.", candidates: [] };

	const pick = (matches: Peer[]): Resolution | undefined => {
		const unique = [...new Map(matches.map((p) => [p.piSessionId, p])).values()];
		if (unique.length === 1) return { ok: true, peer: unique[0]! };
		if (unique.length > 1) {
			return { ok: false, error: `Target "${q}" is ambiguous (${unique.length} matches).`, candidates: unique };
		}
		return undefined;
	};

	const exact = pick(
		peers.filter((p) => p.brokerId === q || p.piSessionId === q || p.name?.toLowerCase() === lower),
	);
	if (exact) return exact;

	const fuzzy = pick(
		peers.filter(
			(p) =>
				(q.length >= 4 && (p.brokerId.startsWith(q) || p.piSessionId.startsWith(q))) ||
				(p.name?.toLowerCase().includes(lower) ?? false),
		),
	);
	if (fuzzy) return fuzzy;

	return { ok: false, error: `No responding session matches "${q}".`, candidates: [] };
}
