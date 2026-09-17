import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export type VisibleRole = "user" | "assistant";

export interface SessionHeader {
	type: "session";
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface ParsedEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	name?: string;
}

export interface VisibleEntry {
	id: string;
	parentId: string | null;
	timestamp: string;
	role: VisibleRole;
	text: string;
}

export interface ParsedTranscript {
	header: SessionHeader;
	entries: ParsedEntry[];
	visibleEntries: VisibleEntry[];
	sessionName?: string;
	hash: string;
	malformedLines: number;
	/** True when the open file or pathname changed after the initial size snapshot. */
	sourceChanged: boolean;
	initialSize: number;
	bytesRead: number;
}

const MAX_JSONL_LINE_CHARS = 8 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function visibleMessage(entry: ParsedEntry, message: unknown): VisibleEntry | undefined {
	if (entry.type !== "message" || !entry.id || !entry.timestamp || !isRecord(message)) return undefined;
	const role = message.role;
	if (role !== "user" && role !== "assistant") return undefined;

	const content = message.content;
	let text = "";
	if (role === "user" && typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		text = content
			.filter(
				(block): block is Record<string, unknown> =>
					isRecord(block) && block.type === "text" && typeof block.text === "string",
			)
			.map((block) => block.text as string)
			.join("\n");
	}
	if (!text.trim()) return undefined;

	return {
		id: entry.id,
		parentId: typeof entry.parentId === "string" ? entry.parentId : null,
		timestamp: entry.timestamp,
		role,
		text,
	};
}

interface TranscriptAccumulator {
	header?: SessionHeader;
	entries: ParsedEntry[];
	visibleEntries: VisibleEntry[];
	sessionName?: string;
	malformedLines: number;
	retainEntries: boolean;
	retainVisibleEntries: boolean;
	onVisibleEntry?: (entry: VisibleEntry) => void;
}

function createAccumulator(options: Pick<ReadTranscriptOptions, "retainEntries" | "retainVisibleEntries" | "onVisibleEntry"> = {}): TranscriptAccumulator {
	return {
		entries: [],
		visibleEntries: [],
		malformedLines: 0,
		retainEntries: options.retainEntries !== false,
		retainVisibleEntries: options.retainVisibleEntries !== false,
		onVisibleEntry: options.onVisibleEntry,
	};
}

function consumeLine(state: TranscriptAccumulator, rawLine: string): void {
	const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
	if (!line.trim()) return;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		state.malformedLines++;
		return;
	}
	if (!isRecord(value) || typeof value.type !== "string") {
		state.malformedLines++;
		return;
	}
	if (value.type === "session") {
		if (
			!state.header &&
			typeof value.id === "string" &&
			typeof value.timestamp === "string" &&
			typeof value.cwd === "string"
		) {
			state.header = {
				type: "session",
				id: value.id,
				timestamp: value.timestamp,
				cwd: value.cwd,
				...(typeof value.parentSession === "string" ? { parentSession: value.parentSession } : {}),
			};
		}
		return;
	}

	const entry: ParsedEntry = {
		type: value.type,
		...(typeof value.id === "string" ? { id: value.id } : {}),
		...(typeof value.parentId === "string" || value.parentId === null ? { parentId: value.parentId } : {}),
		...(typeof value.timestamp === "string" ? { timestamp: value.timestamp } : {}),
		...(value.type === "session_info" && typeof value.name === "string" ? { name: value.name } : {}),
	};
	if (state.retainEntries) state.entries.push(entry);
	if (entry.type === "session_info" && entry.name) state.sessionName = entry.name;
	const visible = visibleMessage(entry, value.message);
	if (visible) {
		state.onVisibleEntry?.(visible);
		if (state.retainVisibleEntries) state.visibleEntries.push(visible);
	}
}

function finishTranscript(
	state: TranscriptAccumulator,
	metadata: Pick<ParsedTranscript, "hash" | "sourceChanged" | "initialSize" | "bytesRead">,
): ParsedTranscript {
	if (!state.header) throw new Error("Session header is missing or invalid");
	return {
		header: state.header,
		entries: state.entries,
		visibleEntries: state.visibleEntries,
		sessionName: state.sessionName,
		malformedLines: state.malformedLines,
		...metadata,
	};
}

/** Parse an in-memory fixture. Runtime reads use readTranscript's bounded streaming path. */
export function parseTranscriptText(raw: string): ParsedTranscript {
	const state = createAccumulator();
	for (const line of raw.split("\n")) consumeLine(state, line);
	return finishTranscript(state, {
		hash: createHash("sha256").update(raw).digest("hex"),
		sourceChanged: false,
		initialSize: Buffer.byteLength(raw),
		bytesRead: Buffer.byteLength(raw),
	});
}

export interface ReadTranscriptOptions {
	signal?: AbortSignal;
	/** Do not retain the branch graph when a streaming consumer does not need it. */
	retainEntries?: boolean;
	/** Do not retain visible text when onVisibleEntry consumes it incrementally. */
	retainVisibleEntries?: boolean;
	onVisibleEntry?: (entry: VisibleEntry) => void;
	/** Deterministic test hook invoked after the initial descriptor snapshot. */
	afterSnapshot?: () => void | Promise<void>;
}

/** Stream and hash one stable initial-size snapshot without loading the full session file. */
export async function readTranscript(path: string, options: ReadTranscriptOptions = {}): Promise<ParsedTranscript> {
	const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
	const handle = await open(path, constants.O_RDONLY | noFollow);
	try {
		const initial = await handle.stat();
		if (!initial.isFile()) throw new Error("Session path is not a regular file");
		const pathStat = await lstat(path);
		if (!pathStat.isFile() || pathStat.dev !== initial.dev || pathStat.ino !== initial.ino) {
			throw new Error("Session path changed before it could be read safely");
		}
		await options.afterSnapshot?.();

		const state = createAccumulator(options);
		const hash = createHash("sha256");
		const decoder = new StringDecoder("utf8");
		let pending = "";
		let lineOverflow = false;
		let bytesRead = 0;
		const acceptText = (text: string) => {
			let offset = 0;
			while (offset < text.length) {
				const newline = text.indexOf("\n", offset);
				const segmentEnd = newline < 0 ? text.length : newline;
				if (!lineOverflow) {
					const segment = text.slice(offset, segmentEnd);
					if (pending.length + segment.length > MAX_JSONL_LINE_CHARS) {
						pending = "";
						lineOverflow = true;
					} else {
						pending += segment;
					}
				}
				if (newline < 0) break;
				if (lineOverflow) state.malformedLines++;
				else consumeLine(state, pending);
				pending = "";
				lineOverflow = false;
				offset = newline + 1;
			}
		};

		if (initial.size > 0) {
			const stream = createReadStream(path, {
				fd: handle.fd,
				autoClose: false,
				start: 0,
				end: initial.size - 1,
				signal: options.signal,
			});
			for await (const chunk of stream) {
				const bytes = chunk as Buffer;
				bytesRead += bytes.length;
				hash.update(bytes);
				acceptText(decoder.write(bytes));
			}
			acceptText(decoder.end());
		}
		if (lineOverflow) state.malformedLines++;
		else if (pending) consumeLine(state, pending);

		const final = await handle.stat();
		let pathnameChanged = false;
		try {
			const finalPathStat = await lstat(path);
			pathnameChanged = finalPathStat.dev !== initial.dev || finalPathStat.ino !== initial.ino;
		} catch {
			pathnameChanged = true;
		}
		const sourceChanged =
			pathnameChanged ||
			bytesRead !== initial.size ||
			final.size !== initial.size ||
			final.mtimeMs !== initial.mtimeMs ||
			final.ctimeMs !== initial.ctimeMs;
		return finishTranscript(state, {
			hash: hash.digest("hex"),
			sourceChanged,
			initialSize: initial.size,
			bytesRead,
		});
	} finally {
		await handle.close();
	}
}

export interface RedactionResult {
	text: string;
	count: number;
}

/** Defense-in-depth masking for high-confidence credential shapes in otherwise visible text. */
export function redactSecrets(input: string): RedactionResult {
	let text = input;
	let count = 0;
	const replace = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
		text = text.replace(pattern, (...args: string[]) => {
			count++;
			return typeof replacement === "string" ? replacement : replacement(...args);
		});
	};

	replace(
		/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|$)/g,
		"[REDACTED:private-key]",
	);
	replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED:aws-access-key]");
	replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[REDACTED:token]");
	replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED:jwt]");
	replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{20,}/gi, (_match, prefix) => `${prefix}[REDACTED:token]`);
	replace(
		/\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|(?:aws[_-]?)?secret[_-]?access[_-]?key|password|passwd)\b(\s*[:=]\s*)(["']?)[^\s,"'}]{12,}\3/gi,
		(_match, key, separator) => `${key}${separator}[REDACTED:credential]`,
	);
	return { text, count };
}

function branchToLeaf(transcript: ParsedTranscript, leaf: ParsedEntry): ParsedEntry[] {
	const byId = new Map(transcript.entries.filter((entry) => entry.id).map((entry) => [entry.id as string, entry]));
	const reversed: ParsedEntry[] = [];
	const seen = new Set<string>();
	let current: ParsedEntry | undefined = leaf;
	while (current) {
		if (!current.id || seen.has(current.id)) throw new Error("Session branch contains an invalid parent cycle");
		seen.add(current.id);
		reversed.push(current);
		current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
	}
	return reversed.reverse();
}

/** Select the active branch, or the newest leaf branch whose ancestry contains anchorId. */
export function selectBranch(transcript: ParsedTranscript, anchorId?: string): ParsedEntry[] {
	const indexed = transcript.entries.flatMap((entry, index) => (entry.id ? [{ entry, index }] : []));
	const byId = new Map(indexed.map(({ entry }) => [entry.id as string, entry]));
	if (anchorId && !byId.has(anchorId)) throw new Error(`Entry anchor not found: ${anchorId}`);
	const parentIds = new Set(indexed.flatMap(({ entry }) => (typeof entry.parentId === "string" ? [entry.parentId] : [])));
	const leaves = indexed.filter(({ entry }) => !parentIds.has(entry.id as string));
	const candidates = leaves.filter(({ entry }) => {
		if (!anchorId) return true;
		return branchToLeaf(transcript, entry).some((branchEntry) => branchEntry.id === anchorId);
	});
	if (anchorId && candidates.length === 0) throw new Error(`No branch contains entry anchor: ${anchorId}`);
	const selected = candidates.sort(
		(a, b) =>
			(b.entry.timestamp ?? "").localeCompare(a.entry.timestamp ?? "") || b.index - a.index,
	)[0];
	return selected ? branchToLeaf(transcript, selected.entry) : [];
}

export function visibleEntriesOnBranch(transcript: ParsedTranscript, anchorId?: string): VisibleEntry[] {
	const branchIds = new Set(selectBranch(transcript, anchorId).flatMap((entry) => (entry.id ? [entry.id] : [])));
	return transcript.visibleEntries.filter((entry) => branchIds.has(entry.id));
}
