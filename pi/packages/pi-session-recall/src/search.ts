import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { readTranscript, redactSecrets, type VisibleEntry, type VisibleRole } from "./transcript";
import { validateSessionPath } from "./session-root";

const MAX_CANDIDATES = 500;
const MAX_RG_OUTPUT_BYTES = 2_000_000;
const SEARCH_TIMEOUT_MS = 10_000;
const SNIPPETS_PER_SESSION = 3;
const SNIPPET_CHARS = 360;

export interface SessionSearchOptions {
	query: string;
	root: string;
	currentSessionPath?: string;
	cwd?: string;
	startDate?: string;
	endDate?: string;
	timezone?: string;
	role?: VisibleRole | "both";
	limit?: number;
	includeCurrent?: boolean;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface SearchSnippet {
	entryId: string;
	timestamp: string;
	role: VisibleRole;
	text: string;
	redactionCount: number;
}

export interface SessionSearchMatch {
	sessionId: string;
	sessionName?: string;
	cwd: string;
	path: string;
	hash: string;
	createdAt: string;
	latestMatchAt: string;
	matchCount: number;
	redactionCount: number;
	sourceChanged: boolean;
	snippets: SearchSnippet[];
}

export interface SessionSearchResult {
	matches: SessionSearchMatch[];
	backend: "rg" | "node";
	candidateCount: number;
	skippedFiles: number;
	candidateLimitReached: boolean;
}

const abortError = (): Error => Object.assign(new Error("Session search was cancelled"), { name: "AbortError" });

function candidateNeedles(query: string): string[] {
	const jsonEncoded = JSON.stringify(query).slice(1, -1);
	return [...new Set([query, jsonEncoded])];
}

async function rgCandidates(query: string, root: string, signal?: AbortSignal): Promise<string[] | undefined> {
	return await new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError());
		const patterns = candidateNeedles(query).flatMap((pattern) => ["-e", pattern]);
		const child = spawn(
			"rg",
			["--files-with-matches", "--ignore-case", "--fixed-strings", "--glob", "*.jsonl", ...patterns, "--", root],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		let output = "";
		let overflow = false;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, SEARCH_TIMEOUT_MS);
		const abort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (output.length + chunk.length > MAX_RG_OUTPUT_BYTES) {
				overflow = true;
				child.kill("SIGKILL");
				return;
			}
			output += chunk;
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (error.code === "ENOENT") resolve(undefined);
			else reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (signal?.aborted) return reject(abortError());
			if (timedOut) return reject(new Error(`ripgrep candidate discovery timed out after ${SEARCH_TIMEOUT_MS}ms`));
			if (overflow) return reject(new Error("ripgrep candidate output exceeded the safety limit"));
			if (code !== 0 && code !== 1) return resolve(undefined);
			resolve(output.split(/\r?\n/).filter(Boolean).slice(0, MAX_CANDIDATES + 1));
		});
	});
}

async function* walkJsonl(root: string, signal?: AbortSignal): AsyncGenerator<string> {
	const stack = [root];
	while (stack.length > 0) {
		if (signal?.aborted) throw abortError();
		const dir = stack.pop() as string;
		let children;
		try {
			children = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const child of children) {
			if (child.isSymbolicLink()) continue;
			const path = join(dir, child.name);
			if (child.isDirectory()) stack.push(path);
			else if (child.isFile() && child.name.endsWith(".jsonl")) yield path;
		}
	}
}

async function fileContains(path: string, needles: string[], signal?: AbortSignal): Promise<boolean> {
	const stream = createReadStream(path, { encoding: "utf8", signal });
	let tail = "";
	const maxNeedleLength = Math.max(...needles.map((needle) => needle.length));
	try {
		for await (const chunk of stream) {
			if (signal?.aborted) throw abortError();
			const text = `${tail}${String(chunk).toLowerCase()}`;
			if (needles.some((needle) => text.includes(needle))) return true;
			tail = text.slice(-Math.max(0, maxNeedleLength - 1));
		}
		return false;
	} finally {
		stream.destroy();
	}
}

async function nodeCandidates(query: string, root: string, signal?: AbortSignal): Promise<string[]> {
	const matches: string[] = [];
	const needles = candidateNeedles(query).map((needle) => needle.toLowerCase());
	for await (const path of walkJsonl(root, signal)) {
		if (await fileContains(path, needles, signal)) matches.push(path);
		if (matches.length > MAX_CANDIDATES) break;
	}
	return matches;
}

function occurrences(haystack: string, needle: string): number {
	const text = haystack.toLowerCase();
	const query = needle.toLowerCase();
	let count = 0;
	let index = 0;
	while ((index = text.indexOf(query, index)) >= 0) {
		count++;
		index += Math.max(1, query.length);
	}
	return count;
}

function snippetAround(text: string, query: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	const index = normalized.toLowerCase().indexOf(query.toLowerCase());
	const center = index < 0 ? 0 : index;
	const start = Math.max(0, center - Math.floor(SNIPPET_CHARS / 2));
	const end = Math.min(normalized.length, start + SNIPPET_CHARS);
	return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

function validateDate(value: string | undefined, field: string): void {
	if (value === undefined) return;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
	const parsed = new Date(`${value}T00:00:00Z`);
	if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
		throw new Error(`${field} is not a valid date`);
	}
}

function localDate(instant: string, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date(instant));
	const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return `${value.year}-${value.month}-${value.day}`;
}

function inDateRange(timestamp: string, startDate: string | undefined, endDate: string | undefined, timezone: string): boolean {
	try {
		const date = localDate(timestamp, timezone);
		return (!startDate || date >= startDate) && (!endDate || date <= endDate);
	} catch {
		return false;
	}
}

function visibleMatchCount(
	entry: VisibleEntry,
	query: string,
	role: VisibleRole | "both",
	startDate: string | undefined,
	endDate: string | undefined,
	timezone: string,
): number {
	if (role !== "both" && entry.role !== role) return 0;
	if (!inDateRange(entry.timestamp, startDate, endDate, timezone)) return 0;
	return occurrences(entry.text, query);
}

export async function searchSessions(options: SessionSearchOptions): Promise<SessionSearchResult> {
	const query = options.query.trim();
	if (!query) throw new Error("query must not be empty");
	if (query.length > 500) throw new Error("query must not exceed 500 characters");
	const safeQuery = redactSecrets(query).text;
	validateDate(options.startDate, "startDate");
	validateDate(options.endDate, "endDate");
	if (options.startDate && options.endDate && options.startDate > options.endDate) {
		throw new Error("startDate must not be after endDate");
	}
	const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
	} catch {
		throw new Error(`Invalid IANA timezone: ${timezone}`);
	}
	const role = options.role ?? "both";
	const limit = options.limit ?? 10;
	if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("limit must be an integer from 1 to 10");

	options.onProgress?.("Discovering candidate session files…");
	let candidates = await rgCandidates(query, options.root, options.signal);
	let backend: "rg" | "node" = "rg";
	if (candidates === undefined) {
		backend = "node";
		const fallbackController = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			fallbackController.abort();
		}, SEARCH_TIMEOUT_MS);
		const abortFallback = () => fallbackController.abort();
		options.signal?.addEventListener("abort", abortFallback, { once: true });
		try {
			candidates = await nodeCandidates(query, options.root, fallbackController.signal);
		} catch (error) {
			if (timedOut) throw new Error(`Node candidate discovery timed out after ${SEARCH_TIMEOUT_MS}ms`);
			throw error;
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abortFallback);
		}
	}
	const candidateLimitReached = candidates.length > MAX_CANDIDATES;
	candidates = candidates.slice(0, MAX_CANDIDATES);
	const candidateCount = candidates.length;
	const matches: SessionSearchMatch[] = [];
	let skippedFiles = 0;
	let currentSessionPath = options.currentSessionPath;
	if (currentSessionPath) {
		try {
			currentSessionPath = await realpath(currentSessionPath);
		} catch {
			// A missing current session file cannot equal a discovered candidate.
		}
	}

	for (let index = 0; index < candidates.length; index++) {
		if (options.signal?.aborted) throw abortError();
		options.onProgress?.(`Checking visible text in candidate ${index + 1}/${candidates.length}…`);
		try {
			const validated = await validateSessionPath(candidates[index], options.root);
			if (!options.includeCurrent && currentSessionPath && validated.path === currentSessionPath) continue;
			const snippets: SearchSnippet[] = [];
			let redactionCount = 0;
			let matchCount = 0;
			let latestMatchAt = "";
			const transcript = await readTranscript(validated.path, {
				signal: options.signal,
				retainEntries: false,
				retainVisibleEntries: false,
				onVisibleEntry: (entry) => {
					const count = visibleMatchCount(
						entry,
						query,
						role,
						options.startDate,
						options.endDate,
						timezone,
					);
					if (count === 0) return;
					matchCount += count;
					if (entry.timestamp > latestMatchAt) latestMatchAt = entry.timestamp;
					if (snippets.length < SNIPPETS_PER_SESSION) {
						// Redact the complete entry before clipping. Clipping first can split a
						// structured secret (for example a PEM block) before its closing marker.
						const redacted = redactSecrets(entry.text);
						redactionCount += redacted.count;
						snippets.push({
							entryId: entry.id,
							timestamp: entry.timestamp,
							role: entry.role,
							text: snippetAround(redacted.text, safeQuery),
							redactionCount: redacted.count,
						});
					}
				},
			});
			if (options.cwd !== undefined && transcript.header.cwd !== options.cwd) continue;
			if (matchCount === 0) continue;
			matches.push({
				sessionId: transcript.header.id,
				sessionName: transcript.sessionName,
				cwd: transcript.header.cwd,
				path: validated.path,
				hash: transcript.hash,
				createdAt: transcript.header.timestamp,
				latestMatchAt: latestMatchAt || transcript.header.timestamp,
				matchCount,
				redactionCount,
				sourceChanged: transcript.sourceChanged,
				snippets,
			});
		} catch (error) {
			if (options.signal?.aborted || (error as Error).name === "AbortError") throw error;
			skippedFiles++;
		}
	}

	matches.sort((a, b) => b.matchCount - a.matchCount || b.latestMatchAt.localeCompare(a.latestMatchAt));
	return {
		matches: matches.slice(0, limit),
		backend,
		candidateCount,
		skippedFiles,
		candidateLimitReached,
	};
}

export function formatSearchResult(query: string, result: SessionSearchResult): string {
	const safeQuery = redactSecrets(query).text;
	if (result.matches.length === 0) {
		const limitNote = result.candidateLimitReached
			? " Candidate discovery hit its 500-file safety cap; narrow the literal query or date/CWD filters."
			: "";
		return `No past sessions contained the literal visible-text query ${JSON.stringify(safeQuery)}.${limitNote}`;
	}
	const sections = result.matches.map((match, index) => {
		const title = match.sessionName ? ` — ${match.sessionName}` : "";
		const snippets = match.snippets
			.map(
				(snippet) =>
					`- [${snippet.role}] ${snippet.timestamp} entry=${snippet.entryId}\n  ${snippet.text}`,
			)
			.join("\n");
		return [
			`## ${index + 1}. ${match.sessionId}${title}`,
			`CWD: ${match.cwd}`,
			`Path: ${match.path}`,
			`SHA-256: ${match.hash}`,
			`Visible matches: ${match.matchCount}; redactions: ${match.redactionCount}${match.sourceChanged ? "; warning: source changed during snapshot read" : ""}`,
			snippets,
		].join("\n");
	});
	const caveat =
		"Historical assistant statements are reports, not proof of current state. Verify any reported mutation against the live repository or service.";
	const limits = result.candidateLimitReached
		? "\nCandidate discovery hit its 500-file safety cap; narrow the literal query or date/CWD filters."
		: "";
	return `Found ${result.matches.length} past session(s) matching ${JSON.stringify(safeQuery)} in visible user/assistant text.\n\n${sections.join("\n\n")}\n\n${caveat}${limits}`;
}
