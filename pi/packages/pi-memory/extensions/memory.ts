import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, CONFIG_DIR_NAME, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isMissing, mutateFile, readOptional } from "./storage.js";
import { projectApproval, setProjectApproval } from "./project-approval.js";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Type } from "typebox";

const EXTENSION_NAME = "pi-memory";
const INJECT_MAX_BYTES = 12_000;
export const TOOL_MAX_BYTES = 50_000;
export const TOOL_MAX_LINES = 2_000;

const TARGETS = ["memory", "scratchpad", "daily", "all"] as const;
const ACTIONS = ["read", "search", "append", "replace", "scratch_done", "audit"] as const;
const HISTORY = ["none", "daily", "archive", "all"] as const;
const SCOPES = ["global", "local", "project"] as const;

type Target = (typeof TARGETS)[number];
type Action = (typeof ACTIONS)[number];
type Scope = (typeof SCOPES)[number];

export type MemoryParams = {
	action: Action;
	target?: Target;
	scope?: Scope;
	text?: string;
	query?: string;
	oldText?: string;
	newText?: string;
	limit?: number;
	section?: string;
	history?: (typeof HISTORY)[number];
	cursor?: string;
};

type MemoryDataParams = Omit<MemoryParams, "action"> & { action?: Action };

type MemoryToolDetails = {
	action: Action;
	target?: Target;
	scope?: Scope;
	files: string[];
	count?: number;
	nextCursor?: string;
};

const inlinePreview = (value: string | undefined, maxChars = 96): string => {
	if (!value) return "";
	const inline = value.replace(/\s+/g, " ").trim();
	return inline.length > maxChars ? `${inline.slice(0, maxChars - 1)}…` : inline;
};

/** Compact, unstyled description used by the TUI tool-call renderer. */
export const describeMemoryCall = (params: Partial<MemoryParams>): string => {
	const action = params.action ?? "…";
	const target = params.target ?? (action === "scratch_done" ? "scratchpad" : "memory");
	const destination = target === "memory" ? `${target}:${params.scope ?? "global"}` : target;
	const section = params.section?.trim() ? ` section=\"${inlinePreview(params.section)}\"` : "";

	switch (action) {
		case "read":
			return `${action} ${destination}${section}`;
		case "search":
			return `${action} \"${inlinePreview(params.query ?? params.text)}\"`;
		case "append":
			return `${action} ${destination}${section} ← \"${inlinePreview(params.text)}\"`;
		case "replace":
			return `${action} ${destination} \"${inlinePreview(params.oldText)}\" → \"${inlinePreview(params.newText)}\"`;
		case "scratch_done":
			return `${action} scratchpad \"${inlinePreview(params.query ?? params.text)}\"`;
		default:
			return `${action} ${destination}`;
	}
};

/** Shorten home-relative paths without hiding which file was actually touched. */
export const compactMemoryPath = (path: string, home = homedir()): string => {
	if (path === home) return "~";
	const prefix = `${home}/`;
	return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
};

const textContent = (content: readonly { type: string; text?: string }[]): string =>
	content
		.filter((item): item is { type: string; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");

type StorePaths = {
	dir: string;
	dailyDir: string;
	memory: string;
	memoryLocal: string;
	scratchpad: string;
	today: string;
	// Project-scoped memory: <projectRoot>/.pi/memory/MEMORY.md. projectRoot is the
	// nearest ancestor of the session cwd containing a .git entry (else cwd itself).
	projectRoot: string;
	projectDir: string;
	project: string;
};

export const MemoryParamsSchema = Type.Object({
	action: StringEnum(ACTIONS),
	target: Type.Optional(
		StringEnum(TARGETS, {
			description: "Default memory for read/writes; all active targets for search. all is allowed for read/search/audit, not writes.",
		}),
	),
	text: Type.Optional(Type.String({ description: "Text to append, or scratchpad item text/query." })),
	query: Type.Optional(Type.String({ description: "Search query or scratchpad item query." })),
	oldText: Type.Optional(Type.String({ description: "Exact text to replace." })),
	newText: Type.Optional(Type.String({ description: "Replacement text." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Search results per page (default 30, maximum 100)." })),
	history: Type.Optional(StringEnum(HISTORY, { description: "Search only: none (default), daily, archive, or all. Adds labeled history after active matches; target=daily explicitly selects daily history. Central archives have local scope; current-project archives have project scope. Backups are excluded." })),
	cursor: Type.Optional(Type.String({ maxLength: 2048, description: "Opaque continuation returned by read/search/audit. Repeat the same arguments plus this cursor. Changed sources require restarting." })),
	section: Type.Optional(
		Type.String({
			description:
				"Existing, unambiguous heading title for memory read/append. A missing or duplicate heading is an error; create headings by appending a Markdown block without section.",
		}),
	),
	scope: Type.Optional(
		StringEnum(SCOPES, {
			description:
				"For memory read/writes: global (default), local, or project. For search/audit filters memory scope (scope alone implies target=memory). Global/project portability depends on your Git/sync setup; this extension does not sync. Not valid for scratchpad/daily.",
		}),
	),
});

const defaultMemoryTemplate = `# Long-term memory

User-maintained durable facts and preferences. No facts are inferred at initialization.

## Preferences

## Other
`;

const defaultMemoryLocalTemplate = `# This-machine memory

Curated context intended for this machine. This extension does not configure sync.
Use this for machine-bound paths, the role of this machine (e.g. work vs
personal), and project/operational context that only applies here.

## Machine

## Other
`;

const defaultScratchpadTemplate = `# Memory scratchpad

Checklist of user-recorded follow-ups, unresolved issues, and candidate memories.
`;

export const todayString = (date = new Date()): string => {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
};

export const timeString = (date = new Date()): string => {
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
};

// Walk up from cwd to the nearest ancestor containing a `.git` entry (the
// project root). Falls back to cwd when not inside a work tree. Pure filesystem,
// so no git dependency and matches pi's `<cwd>/.pi/agents/` project convention.
export const findProjectRoot = (cwd: string): string => {
	let dir = cwd;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return cwd;
		dir = parent;
	}
};

const getStorePaths = (cwd: string = process.cwd()): StorePaths => {
	const dir = join(getAgentDir(), "memory");
	const dailyDir = join(dir, "daily");
	const today = todayString();
	const projectRoot = findProjectRoot(cwd);
	const projectDir = join(projectRoot, CONFIG_DIR_NAME, "memory");
	return {
		dir,
		dailyDir,
		memory: join(dir, "MEMORY.md"),
		memoryLocal: join(dir, "MEMORY.local.md"),
		scratchpad: join(dir, "SCRATCHPAD.md"),
		today: join(dailyDir, `${today}.md`),
		projectRoot,
		projectDir,
		project: join(projectDir, "MEMORY.md"),
	};
};

// Resolve the curated file for a scope. Storage alone does not configure tracking or sync.
export const memoryPathForScope = (paths: StorePaths, scope: Scope | undefined): string =>
	scope === "local" ? paths.memoryLocal : scope === "project" ? paths.project : paths.memory;

const writeFileIfMissing = async (path: string, content: string): Promise<void> => {
	// Fast read-only path for existing stores. Never chmod an existing file.
	if (await readOptional(path) !== undefined) return;
	await withFileMutationQueue(path, () => mutateFile(path, (current) => current ?? content));
};

// NOTE: deliberately does NOT create the project file — that would litter every
// repo the user opens. Project memory is created lazily on first scope=project write.
export const ensureStore = async (cwd?: string): Promise<StorePaths> => {
	const paths = getStorePaths(cwd);
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	await mkdir(paths.dailyDir, { recursive: true, mode: 0o700 });
	await writeFileIfMissing(paths.memory, defaultMemoryTemplate);
	await writeFileIfMissing(paths.memoryLocal, defaultMemoryLocalTemplate);
	await writeFileIfMissing(paths.scratchpad, defaultScratchpadTemplate);
	return paths;
};

const ensureDailyFile = async (paths: StorePaths): Promise<void> => {
	const day = todayString();
	await writeFileIfMissing(paths.today, `# ${day}\n`);
};

const readTextFile = async (path: string): Promise<string> => {
	const text = await readOptional(path);
	if (text === undefined) throw new Error(`Memory file does not exist: ${path}`);
	return text;
};

/** Bound bytes, UTF-16 units and lines without splitting Unicode code points. */
export const boundedPrefix = (text: string, maxBytes: number, maxLines = TOOL_MAX_LINES, maxChars = maxBytes): string => {
	let bytes = 0, chars = 0, lines = 1;
	for (const ch of text) {
		const size = Buffer.byteLength(ch);
		if (bytes + size > maxBytes || chars + ch.length > maxChars || (ch === "\n" && lines >= maxLines)) break;
		bytes += size; chars += ch.length;
		if (ch === "\n") lines++;
	}
	return text.slice(0, chars);
};
export const truncateText = (text: string, maxChars: number): { text: string; truncated: boolean } => {
	if (text.length <= maxChars) return { text, truncated: false };
	const note = "\n[Truncated]";
	return { text: boundedPrefix(text, Math.max(0, maxChars - note.length)) + boundedPrefix(note, maxChars), truncated: true };
};

export const headingLevel = (line: string): number => /^(?: {0,3})(#{1,6})(?:\s|$)/.exec(line)?.[1]?.length ?? 0;
export const headingText = (line: string): string => line.replace(/^ {0,3}#{1,6}(?:\s+|$)/, "").replace(/\s+#+\s*$/, "").trim();

/** CommonMark-style fences: same character, closing run >= opener, no closing info. */
export const outsideFenceLines = (lines: string[]): boolean[] => {
	let fence: { marker: string; length: number } | undefined;
	return lines.map((line) => {
		const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (match && match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
			return false;
		}
		if (match && !(match[1]![0] === "`" && match[2]!.includes("`"))) {
			fence = { marker: match[1]![0]!, length: match[1]!.length };
			return false;
		}
		return true;
	});
};
export const parseHeadings = (lines: string[]): { index: number; level: number; title: string }[] => {
	const outside = outsideFenceLines(lines);
	return lines.flatMap((line, index) => outside[index] && headingLevel(line) ? [{ index, level: headingLevel(line), title: headingText(line) }] : []);
};

// Range of a Markdown section: [heading line, next heading of same-or-higher level).
export const findSectionRange = (lines: string[], section: string): { start: number; end: number; level: number } | null => {
	const heads = parseHeadings(lines);
	const needle = section.trim().toLowerCase();
	if (heads.filter((head) => head.title.toLowerCase() === needle).length > 1) throw new Error(`Ambiguous section "${section}"; duplicate headings. Use a full read and exact replacement to disambiguate.`);
	for (let k = 0; k < heads.length; k++) {
		const head = heads[k];
		if (!head || head.title.toLowerCase() !== needle) continue;
		let end = lines.length;
		for (let m = k + 1; m < heads.length; m++) {
			if ((heads[m]?.level ?? 0) <= head.level) {
				end = heads[m]?.index ?? lines.length;
				break;
			}
		}
		return { start: head.index, end, level: head.level };
	}
	return null;
};

// Compact outline of the '##' / '###' headings, for orienting in a large file.
export const buildOutline = (content: string): string =>
	parseHeadings(content.split("\n"))
		.filter((head) => head.level === 2 || head.level === 3)
		.map((head) => (head.level === 2 ? `- ${head.title}` : `  - ${head.title}`))
		.join("\n");

const resolveTargetPath = async (
	target: Target | undefined,
	scope?: Scope,
	cwd?: string,
): Promise<{ paths: StorePaths; path?: string }> => {
	const paths = getStorePaths(cwd);
	const resolved = target ?? "memory";
	if (resolved === "memory") return { paths, path: memoryPathForScope(paths, scope) };
	if (resolved === "scratchpad") return { paths, path: paths.scratchpad };
	if (resolved === "daily") return { paths, path: paths.today };
	return { paths };
};

const formatFileBlock = (storeDir: string, path: string, content: string): string => {
	const rel = relative(storeDir, path) || path;
	return `## ${rel}\n\n${content.trimEnd()}`;
};

// Human-readable path for messages: project file shown relative to its repo
// root, everything else relative to the central store dir.
const displayPath = (paths: StorePaths, path: string): string =>
	path === paths.project ? relative(paths.projectRoot, path) : relative(paths.dir, path);

const readTarget = async (target: Target | undefined, scope?: Scope, cwd?: string): Promise<{ text: string; files: string[] }> => {
	const { paths, path } = await resolveTargetPath(target, scope, cwd);
	if ((target ?? "memory") === "all") {
		const files: string[] = [], blocks: string[] = [];
		for (const file of [paths.memory, paths.memoryLocal, paths.scratchpad, paths.today, paths.project]) {
			const content = await readOptional(file);
			if (content === undefined) continue;
			files.push(file);
			blocks.push(formatFileBlock(file === paths.project ? paths.projectRoot : paths.dir, file, content));
		}
		return { text: blocks.join("\n\n---\n\n"), files };
	}
	if (!path) throw new Error("No path resolved for target");
	if (scope === "project" && await readOptional(path) === undefined) {
		return { text: `No project memory yet at ${path}. Append with scope="project" to create it.`, files: [] };
	}
	return { text: await readTextFile(path), files: [path] };
};

export const readSection = async (
	target: Target | undefined,
	section: string,
	scope?: Scope,
	cwd?: string,
): Promise<{ text: string; files: string[] }> => {
	const { paths, path } = await resolveTargetPath(target ?? "memory", scope, cwd);
	if (!path) throw new Error("Section read requires target=memory.");
	if (scope === "project" && await readOptional(path) === undefined) return { text: `No project memory yet at ${path}.`, files: [] };
	const content = await readTextFile(path);
	const lines = content.split("\n");
	const range = findSectionRange(lines, section);
	if (!range) throw new Error(`Section "${section}" not found in ${displayPath(paths, path)}. Available sections:\n${boundedPrefix(buildOutline(content), 2000)}`);
	return { text: lines.slice(range.start, range.end).join("\n").trimEnd(), files: [path] };
};

type SearchFile = { file: string; tier: "active" | "history:daily" | "history:archive"; scope: Scope | "machine"; target: "memory" | "scratchpad" | "daily" };
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const encodeCursor = (data: unknown): string => Buffer.from(JSON.stringify(data)).toString("base64url");
const decodeCursor = (cursor: string | undefined, signature: string): { index: number; line: number } => {
	if (!cursor) return { index: 0, line: 0 };
	try {
		if (cursor.length > 2048) throw new Error();
		const data = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (data.signature !== signature || !Number.isSafeInteger(data.index) || data.index < 0 || !Number.isSafeInteger(data.line) || data.line < 0) throw new Error();
		return data;
	} catch { throw new Error("Invalid or stale memory cursor. Restart without cursor using the same query/filters; sources may have changed."); }
};
// Canonical field order: JSON argument ordering must not invalidate a continuation.
const selectionKey = (params: MemoryDataParams): unknown => ({
	action: params.action, target: params.target, scope: params.scope, query: params.query,
	text: params.text, oldText: params.oldText, newText: params.newText,
	limit: params.limit, section: params.section, history: params.history,
});

export const pageText = (text: string, params: MemoryDataParams, identity: unknown): { text: string; nextCursor?: string } => {
	const signature = digest([identity, selectionKey(params), text]);
	const { index } = decodeCursor(params.cursor, signature);
	if (index > text.length || (index > 0 && /[\uDC00-\uDFFF]/.test(text[index] ?? ""))) throw new Error("Invalid memory read cursor offset.");
	const body = boundedPrefix(text.slice(index), TOOL_MAX_BYTES - 2000, TOOL_MAX_LINES - 10);
	if (index + body.length === text.length) return { text: body };
	const nextCursor = encodeCursor({ signature, index: index + body.length, line: 0 });
	return { text: `${body}\n\n[Output truncated. Repeat the same memory arguments with cursor="${nextCursor}".]`, nextCursor };
};

const isBackup = (name: string): boolean => /(?:^|[._-])(?:backups?|bak|rollback)(?:$|[._-])/i.test(name) || name.endsWith("~");
/** Only explicit history roots; never follow history symlinks or inspect sibling projects. */
const historyFiles = async (root: string): Promise<string[]> => {
	const files: string[] = [];
	let entriesSeen = 0;
	const visit = async (dir: string, depth: number): Promise<void> => {
		let info;
		try { info = await lstat(dir); } catch (error) { if (isMissing(error)) return; throw error; }
		if (info.isSymbolicLink()) return;
		if (!info.isDirectory()) throw new Error(`History root is not a directory: ${dir}`);
		if (depth > 16) throw new Error(`History nesting exceeds 16 levels: ${dir}`);
		const entries = await readdir(dir, { withFileTypes: true });
		entriesSeen += entries.length;
		if (entriesSeen > 5000) throw new Error(`History inventory exceeds 5000 entries at ${root}; narrow history/scope or use filesystem tools.`);
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (isBackup(entry.name) || entry.name.startsWith(".")) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await visit(path, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
		}
	};
	await visit(root, 0);
	return files;
};

const selectSearchFiles = async (params: MemoryDataParams, cwd?: string): Promise<SearchFile[]> => {
	const paths = getStorePaths(cwd);
	let selected: SearchFile[] = [
		{ file: paths.memory, tier: "active", scope: "global", target: "memory" },
		{ file: paths.memoryLocal, tier: "active", scope: "local", target: "memory" },
		{ file: paths.project, tier: "active", scope: "project", target: "memory" },
		{ file: paths.scratchpad, tier: "active", scope: "machine", target: "scratchpad" },
	];
	const history = params.history ?? (params.target === "daily" ? "daily" : "none");
	if ((history === "daily" || history === "all") && !params.scope && (!params.target || params.target === "all" || params.target === "daily")) {
		selected.push(...(await historyFiles(paths.dailyDir)).map((file): SearchFile => ({ file, tier: "history:daily", scope: "machine", target: "daily" })));
	}
	if ((history === "archive" || history === "all") && (!params.target || params.target === "all" || params.target === "memory")) {
		for (const [root, scope] of [[join(paths.dir, "archive"), "local"], [join(paths.projectDir, "archive"), "project"]] as const) {
			if (params.scope && params.scope !== scope) continue;
			selected.push(...(await historyFiles(root)).map((file): SearchFile => ({ file, tier: "history:archive", scope, target: "memory" })));
		}
	}
	selected = selected.filter((entry) => (!params.target || params.target === "all" || entry.target === params.target) && (!params.scope || entry.scope === params.scope));
	const existing: SearchFile[] = [];
	for (const entry of selected) {
		try {
			const info = await stat(entry.file);
			if (!info.isFile()) throw new Error(`Not a regular memory file: ${entry.file}`);
			existing.push(entry);
		} catch (error) {
			if (!isMissing(error)) throw error;
			// A dangling canonical symlink is an error, not an absent memory file.
			const link = await lstat(entry.file).catch((e) => { if (!isMissing(e)) throw e; return undefined; });
			if (link) throw new Error(`Dangling memory symlink: ${entry.file}`);
		}
	}
	return existing;
};

export const searchMemory = async (params: MemoryDataParams, cwd?: string): Promise<{ text: string; files: string[]; count: number; nextCursor?: string }> => {
	const query = params.query?.trim() || params.text?.trim();
	if (!query) throw new Error("query is required for memory search.");
	const scanned = await selectSearchFiles(params, cwd);
	const versions = [];
	for (const entry of scanned) {
		const info = await stat(entry.file);
		versions.push([entry, await realpath(entry.file), info.ino, info.size, info.mtimeMs, info.ctimeMs]);
	}
	const signature = digest([selectionKey(params), versions]);
	const start = decodeCursor(params.cursor, signature);
	if (start.index > scanned.length) throw new Error("Invalid memory search cursor offset.");
	const needle = query.toLowerCase();
	const limit = params.limit ?? 30;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100.");
	const matches: string[] = [], files: string[] = [];
	let bytesScanned = 0;
	const finish = (index?: number, line = 0) => {
		const nextCursor = index === undefined ? undefined : encodeCursor({ signature, index, line });
		const text = matches.join("\n") || (nextCursor ? "No matches in this scan page." : `No memory matches for: ${boundedPrefix(query, 1000)}`);
		return { text: text + (nextCursor ? `\n\n[Search truncated (result/output/scan budget). Repeat the same arguments with cursor="${nextCursor}".]` : ""), files, count: matches.length, nextCursor };
	};
	for (let index = start.index; index < scanned.length; index++) {
		if (files.length >= 64 || bytesScanned >= 16 * 1024 * 1024) return finish(index);
		const entry = scanned[index]!;
		const content = await readTextFile(entry.file);
		bytesScanned += Buffer.byteLength(content);
		files.push(entry.file);
		const lines = content.split("\n");
		if (index === start.index && start.line > lines.length) throw new Error("Invalid memory search cursor line.");
		const heads = new Map(parseHeadings(lines).map((head) => [head.index, head]));
		const stack: { level: number; title: string }[] = [];
		for (let i = 0; i < lines.length; i++) {
			const head = heads.get(i);
			if (head) {
				while (stack.length && stack[stack.length - 1]!.level >= head.level) stack.pop();
				stack.push(head);
			}
			if (index === start.index && i < start.line) continue;
			const line = lines[i]!;
			if (!line.toLowerCase().includes(needle)) continue;
			const crumb = boundedPrefix(stack.map((s) => s.title).join(" › "), 300);
			const preview = boundedPrefix(line, 800, 1);
			const match = `[${entry.tier}/${entry.scope}] ${JSON.stringify(entry.file)} › ${crumb}:${i + 1}: ${preview}${preview.length < line.length ? " [line excerpt; use filesystem read at this path/line]" : ""}`;
			if (matches.length >= limit || Buffer.byteLength(matches.join("\n")) + Buffer.byteLength(match) > TOOL_MAX_BYTES - 2000) return finish(index, i);
			matches.push(match);
		}
	}
	return finish();
};

export const appendToTarget = async (params: MemoryDataParams, cwd?: string, signal?: AbortSignal): Promise<{ text: string; files: string[] }> => {
	const target = params.target ?? "memory";
	const text = params.text?.trim();
	if (!text) throw new Error("text is required for append.");
	if (target === "all") throw new Error("target=all is not valid for append.");
	const { paths, path } = await resolveTargetPath(target, params.scope, cwd);
	if (!path) throw new Error("No path resolved for append target");
	let resultText = `Appended to ${displayPath(paths, path)}.`;
	await withFileMutationQueue(path, () => mutateFile(path, (value) => {
		const current = value ?? (target === "daily" ? `# ${todayString()}\n` : "");
		if (target === "memory") {
			const sectionName = params.section?.trim();
			if (sectionName) {
				const lines = current.split("\n");
				const range = findSectionRange(lines, sectionName);
				if (!range) throw new Error(`Section "${sectionName}" not found; nothing written. Create a heading by appending a Markdown block without section. Available sections:\n${boundedPrefix(buildOutline(current), 2000)}`);
				let insertAt = range.end;
				while (insertAt > range.start + 1 && !lines[insertAt - 1]!.trim()) insertAt--;
				lines.splice(insertAt, 0, "", text, "");
				resultText = `Appended under "${sectionName}" in ${displayPath(paths, path)}.`;
				return lines.join("\n");
			}
			return `${current}${current.length && !current.endsWith("\n") ? "\n" : ""}\n${text}\n`;
		}
		const entry = target === "scratchpad" ? `- [ ] ${text}\n` : `- ${timeString()} — ${text}\n`;
		return `${current}${current.length && !current.endsWith("\n") ? "\n" : ""}${entry}`;
	}, { signal }));
	return { text: resultText, files: [path] };
};

export const replaceInTarget = async (params: MemoryDataParams, cwd?: string, signal?: AbortSignal): Promise<{ text: string; files: string[] }> => {
	const target = params.target ?? "memory";
	if (target === "daily" || target === "all") throw new Error("replace is only allowed for memory or scratchpad. Daily logs are append-only.");
	if (!params.oldText) throw new Error("oldText is required for replace.");
	if (params.newText === undefined) throw new Error("newText is required for replace.");
	const { paths, path } = await resolveTargetPath(target, params.scope, cwd);
	if (!path) throw new Error("No path resolved for replace target");
	await withFileMutationQueue(path, () => mutateFile(path, (current) => {
		if (current === undefined) throw new Error(`${path} does not exist yet — nothing to replace.`);
		const oldText = params.oldText!;
		const first = current.indexOf(oldText);
		if (first < 0) throw new Error(`oldText was not found in ${displayPath(paths, path)}.`);
		// Check overlapping occurrences too: "aa" in "aaa" is ambiguous.
		if (current.indexOf(oldText, first + 1) >= 0) throw new Error(`oldText matched 2 or more times in ${displayPath(paths, path)}. Use a more specific oldText.`);
		return current.slice(0, first) + params.newText + current.slice(first + oldText.length);
	}, { signal }));
	return { text: `Replaced one occurrence in ${displayPath(paths, path)}.`, files: [path] };
};

export const markScratchDone = async (params: MemoryDataParams, cwd?: string, signal?: AbortSignal): Promise<{ text: string; files: string[] }> => {
	const query = params.query?.trim() || params.text?.trim();
	if (!query) throw new Error("query or text is required for scratch_done.");
	const { paths } = await resolveTargetPath("scratchpad", undefined, cwd);
	const path = paths.scratchpad;
	let result = "";
	await withFileMutationQueue(path, () => mutateFile(path, (current) => {
		if (current === undefined) throw new Error(`Scratchpad does not exist: ${path}`);
		const lines = current.split("\n");
		const outside = outsideFenceLines(lines);
		const matches = lines.flatMap((line, index) => outside[index] && /^\s*-\s+\[ \]\s+/.test(line) && line.toLowerCase().includes(query.toLowerCase()) ? [index] : []);
		if (!matches.length) throw new Error(`no incomplete scratchpad item matched: ${query}`);
		if (matches.length > 1) throw new Error(`${matches.length} scratchpad items matched. Use a more specific query.`);
		const index = matches[0]!;
		lines[index] = lines[index]!.replace(/^(\s*-\s+)\[ \](\s+)/, "$1[x]$2");
		result = `Marked scratchpad item done: ${boundedPrefix(lines[index]!, 1000)}`;
		return lines.join("\n");
	}, { signal }));
	return { text: result, files: [path] };
};

/** Metadata only: no heading titles, task text, excerpts, or semantic judgments. */
export const auditMemory = async (params: MemoryDataParams, cwd?: string, projectTrusted = false): Promise<{ text: string; files: string[]; nextCursor?: string }> => {
	const paths = getStorePaths(cwd);
	const approval = await projectApproval(paths.projectRoot, projectTrusted, cwd);
	projectTrusted = approval.approved;
	const entries: SearchFile[] = [
		{ file: paths.memory, tier: "active", scope: "global", target: "memory" },
		{ file: paths.memoryLocal, tier: "active", scope: "local", target: "memory" },
		{ file: paths.project, tier: "active", scope: "project", target: "memory" },
		{ file: paths.scratchpad, tier: "active", scope: "machine", target: "scratchpad" },
	];
	const rows: unknown[] = [];
	for (const entry of entries) {
		if (params.target && params.target !== "all" && entry.target !== params.target || params.scope && entry.scope !== params.scope) continue;
		const raw = await readOptional(entry.file);
		if (raw === undefined) { rows.push({ ...entry, exists: false }); continue; }
		const info = await lstat(entry.file);
		const targetInfo = await stat(entry.file);
		const lines = raw.split("\n"), heads = parseHeadings(lines), outside = outsideFenceLines(lines);
		const counts = new Map<string, number>();
		for (const head of heads) counts.set(head.title.toLowerCase(), (counts.get(head.title.toLowerCase()) ?? 0) + 1);
		const injected = raw.trim() && entry.target === "memory" && (entry.scope !== "project" || projectTrusted) ? renderInjection(raw, entry.scope as Scope, entry.file) : undefined;
		rows.push({ ...entry, exists: true, canonicalPath: await realpath(entry.file), symlink: info.isSymbolicLink(),
			bytes: targetInfo.size, characters: raw.length, modifiedAt: targetInfo.mtime.toISOString(), mode: (targetInfo.mode & 0o7777).toString(8), lines: lines.length, headings: heads.length,
			duplicateHeadingGroups: [...counts.values()].filter((n) => n > 1).length,
			malformedHeadingLines: lines.flatMap((line, index) => outside[index] && (/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?#{1,6}(?:\s|$)/.test(line) || /^ {0,3}#{1,6}[^#\s]/.test(line)) ? [index + 1] : []),
			openCheckboxes: lines.filter((line, i) => outside[i] && /^\s*-\s+\[ \]\s+/.test(line)).length,
			completedCheckboxes: lines.filter((line, i) => outside[i] && /^\s*-\s+\[[xX]\]\s+/.test(line)).length,
			injection: { eligible: !!injected, reason: !raw.trim() ? "empty memory" : entry.target !== "memory" ? "not curated memory" : entry.scope === "project" && !projectTrusted ? approval.source : "curated", bodyCharacters: injected?.bodyCharacters ?? 0, sourceCharacters: raw.length, outputBytes: injected ? Buffer.byteLength(injected.text) : 0, truncated: injected?.truncated ?? false },
		});
	}
	const history = [];
	for (const [root, tier, scope, target] of [
		[paths.dailyDir, "history:daily", "machine", "daily"],
		[join(paths.dir, "archive"), "history:archive/local", "local", "memory"],
		[join(paths.projectDir, "archive"), "history:archive/project", "project", "memory"],
	] as const) {
		if (params.target && params.target !== "all" && params.target !== target || params.scope && params.scope !== scope) continue;
		const files = await historyFiles(root);
		let bytes = 0;
		for (const file of files) bytes += (await stat(file)).size;
		history.push({ root, tier, files: files.length, bytes, defaultSearch: false });
	}
	const report = { store: paths.dir, projectRoot: paths.projectRoot, projectTrusted, projectApproval: approval, active: rows, history, defaultSearch: "global/local/current-project memory + scratchpad", excludes: "backups, unrelated projects, history symlinks", limits: { fileBytes: 8 * 1024 * 1024, injectionBytesPerScope: INJECT_MAX_BYTES, outputBytes: TOOL_MAX_BYTES, outputLines: TOOL_MAX_LINES }, portability: "No sync or Git tracking is performed; verify ignored/untracked project memory separately." };
	return { ...pageText(JSON.stringify(report, null, 2), params, ["audit", cwd]), files: [] };
};

/** Complete block, including labels, outline and continuation, stays under 12k bytes/650 lines. */
export const renderInjection = (raw: string, scope: Scope, path: string): { text: string; bodyCharacters: number; truncated: boolean } => {
	const label = `## Persistent memory (${scope})\nSource: ${JSON.stringify(path)}\n${scope === "project" ? "Trusted current-project context." : "User-maintained memory."} Storage location does not guarantee sync or Git tracking.\n\n`;
	const available = INJECT_MAX_BYTES - Buffer.byteLength(label);
	if (available < 1000) throw new Error("Memory source path too long for injection budget.");
	const full = boundedPrefix(raw, available, 630);
	if (full.length === raw.length) return { text: label + raw, bodyCharacters: raw.length, truncated: false };
	const outline = boundedPrefix(buildOutline(raw), 1800, 50);
	const suffix = `\n\n[Memory truncated. Read complete pages: memory action=read target=memory scope=${scope}; follow returned cursor. Read a unique section with section=heading.]\nPartial section outline (not exhaustive):\n${outline}`;
	const body = boundedPrefix(raw, Math.max(0, available - Buffer.byteLength(suffix)), 570);
	return { text: label + body + suffix, bodyCharacters: body.length, truncated: true };
};

const buildCommandPathMessage = async (target: string | undefined, cwd?: string): Promise<string> => {
	const paths = await ensureStore(cwd);
	const normalized = target?.trim().toLowerCase();
	if (normalized === "project" || normalized === "memory.project" || normalized === "project.md") return paths.project;
	if (normalized === "memory" || normalized === "memory.md") return paths.memory;
	if (normalized === "scratchpad" || normalized === "scratchpad.md") return paths.scratchpad;
	if (normalized === "daily" || normalized === "today" || normalized === "today daily") {
		await ensureDailyFile(paths);
		return paths.today;
	}
	if (normalized === "local" || normalized === "memory.local" || normalized === "memory.local.md") return paths.memoryLocal;
	if (normalized === "dir" || normalized === "directory") return paths.dir;
	return [
		`Memory directory: ${paths.dir}`,
		`MEMORY.md (global): ${paths.memory}`,
		`MEMORY.local.md (this machine): ${paths.memoryLocal}`,
		`MEMORY.md (project): ${paths.project}${existsSync(paths.project) ? "" : " (not created yet)"}`,
		`SCRATCHPAD.md: ${paths.scratchpad}`,
		`Today: ${paths.today}`,
	].join("\n");
};

export const validateParams = (params: MemoryParams): void => {
	if (!ACTIONS.includes(params.action)) throw new Error("Unsupported memory action.");
	if (params.target !== undefined && !TARGETS.includes(params.target)) throw new Error("Invalid memory target.");
	if (params.scope !== undefined && !SCOPES.includes(params.scope)) throw new Error("Invalid memory scope.");
	if (params.history !== undefined && (!HISTORY.includes(params.history) || params.action !== "search")) throw new Error("history is only valid for search (none/daily/archive/all).");
	if (params.limit !== undefined && (params.action !== "search" || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)) throw new Error("limit is search-only, an integer from 1 to 100.");
	if (params.cursor !== undefined && (!["read", "search", "audit"].includes(params.action) || typeof params.cursor !== "string" || params.cursor.length > 2048)) throw new Error("cursor is only valid for paged read/search/audit.");
	if (params.scope && (params.target === "scratchpad" || params.target === "daily" || (params.target === "all" && params.action === "read") || params.action === "scratch_done")) throw new Error("scope applies only to memory, or search/audit filtering.");
	if (params.section !== undefined && (!params.section.trim() || !["read", "append"].includes(params.action) || (params.target ?? "memory") !== "memory")) throw new Error("section requires memory read/append and a nonempty heading title.");
	if (params.target === "all" && !["read", "search", "audit"].includes(params.action)) throw new Error("target=all is only valid for read/search/audit.");
	if (params.action === "scratch_done" && params.target && params.target !== "scratchpad") throw new Error("scratch_done only accepts target=scratchpad.");
	if (params.action === "search" && params.target === "daily" && params.history && !["daily", "all"].includes(params.history)) throw new Error("target=daily requires daily history (omit history or use daily/all).");
};

export default function memoryExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			await ensureStore(ctx.cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`${EXTENSION_NAME}: failed to initialize memory store: ${message}`, "error");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const paths = getStorePaths(ctx.cwd);
		const blocks: string[] = [];
		for (const scope of SCOPES) {
			// Explicit tool access remains available; trust guards automatic input loading.
			const path = memoryPathForScope(paths, scope);
			try {
				if (scope === "project" && !(await projectApproval(paths.projectRoot, ctx.isProjectTrusted?.() === true, ctx.cwd)).approved) continue;
				const raw = await readOptional(path);
				if (raw?.trim()) blocks.push(renderInjection(raw, scope, path).text);
			} catch (error) {
				ctx.ui.notify(`${EXTENSION_NAME}: cannot inject ${scope} memory: ${String(error)}`, "error");
			}
		}
		if (blocks.length) return { systemPrompt: `${event.systemPrompt}\n\n${blocks.join("\n\n")}` };
	});

	pi.registerCommand("memory", {
		description: "Show memory paths or metadata-only /memory audit [cursor]; approve-project/revoke-project require TUI confirmation",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "approve-project" || trimmed === "revoke-project") {
				if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Project-memory approval changes require a user confirmation in the interactive TUI.");
				const root = await realpath(getStorePaths(ctx.cwd).projectRoot);
				const approve = trimmed === "approve-project";
				if (!await ctx.ui.confirm(approve ? "Approve project-memory injection?" : "Revoke project-memory injection?", `${root}\n${approve ? "Automatically load this root's curated memory in future sessions on this machine. Host trust denials still apply." : "Stop automatically injecting memory from this root, even when host trust is active."}`)) return;
				await setProjectApproval(root, approve);
				ctx.ui.notify(`Project-memory injection ${approve ? "approved" : "revoked"} for ${root}. Host trust denials still apply.`, "info");
				return;
			}
			if (trimmed === "audit" || trimmed.startsWith("audit ")) {
				const result = await auditMemory({ action: "audit", cursor: trimmed.slice(5).trim() || undefined }, ctx.cwd, ctx.isProjectTrusted?.() === true);
				ctx.ui.notify(result.text + (result.nextCursor ? `\nCommand continuation: /memory audit ${result.nextCursor}` : ""), "info");
				return;
			}
			let target = trimmed;
			if (!target && ctx.hasUI) {
				const choice = await ctx.ui.select("Memory", ["directory", "MEMORY.md", "MEMORY.local.md", "project", "SCRATCHPAD.md", "today daily"]);
				if (!choice) return;
				target = choice;
			}
			const message = await buildCommandPathMessage(target, ctx.cwd);
			ctx.ui.notify(message, "info");
		},
	});

	pi.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Read and update persistent memory in Pi's agent-directory store and the current project. " +
			"Use for durable preferences, decisions, and follow-ups. Search defaults to active canonical files only; opt into history. Output is capped at 50,000 bytes/2,000 lines with cursors; audit is metadata-only.",
		promptSnippet: "Read or update persistent Markdown memory in the agent directory and current project",
		promptGuidelines: [
			"Use memory opportunistically when durable preferences, recurring facts, decisions, discoveries, or follow-up tasks would help future pi sessions.",
			"Use memory target=memory for stable long-term facts/preferences; target=scratchpad for uncertain reminders or cleanup items; target=daily for timestamped session facts, decisions, and discoveries.",
			"For target=memory, choose scope: omit/scope=global for portable facts that apply across all machines and contexts (preferences, general tooling/process lessons); scope=local for facts specific to THIS machine (its role e.g. work vs personal, machine-bound paths); scope=project for facts tied to the CURRENT repo/project (architecture, build commands, project-specific gotchas) — stored in <repo>/.pi/memory/MEMORY.md. Neither location guarantees tracking, sync, or availability across worktrees; this extension does not configure those.",
			"When appending to target=memory, pass a well-formed Markdown block (e.g. a `### Title` heading plus body). Set `section` to an EXISTING `##` heading to insert under it; if the section doesn't exist the append is rejected (with the section list) rather than fragmenting the file. To create a new section, append a block whose first line is `## Title` and omit `section`. Don't append bare bullets or `- ##` headers.",
			"To inspect large memory, read a unique section or follow the returned cursor with the same arguments. memory search defaults to active files; request history=daily/archive/all for labeled historical evidence, not current facts.",
			"Use memory search/read before adding long-term memory when duplication or conflict is likely.",
			"Do not store secrets, credentials, private tokens, or highly ephemeral implementation details in memory.",
		],
		parameters: MemoryParamsSchema,
		async execute(_toolCallId, params: MemoryParams, _signal, _onUpdate, ctx) {
			try {
				validateParams(params);
				_signal?.throwIfAborted();
				let output: { text: string; files: string[]; count?: number; nextCursor?: string };
				const cwd = ctx?.cwd;
				switch (params.action) {
					case "read": {
						const result = params.section ? await readSection(params.target, params.section, params.scope, cwd) : await readTarget(params.target, params.scope, cwd);
						output = { ...result, ...pageText(result.text, params, result.files) };
						break;
					}
					case "search": output = await searchMemory(params, cwd); break;
					case "audit": output = await auditMemory(params, cwd, ctx?.isProjectTrusted?.() === true); break;
					case "append": output = await appendToTarget(params, cwd, _signal); break;
					case "replace": output = await replaceInTarget(params, cwd, _signal); break;
					case "scratch_done": output = await markScratchDone(params, cwd, _signal); break;
				}
				return {
					content: [{ type: "text", text: boundedPrefix(output.text, TOOL_MAX_BYTES, TOOL_MAX_LINES) }],
					details: { action: params.action, target: params.target, scope: params.scope, files: output.files, count: output.count, nextCursor: output.nextCursor } satisfies MemoryToolDetails,
				};
			} catch (error) {
				// Pi only sets isError when execute throws; an isError return field is ignored.
				const message = error instanceof Error ? error.message : String(error);
				const bounded = boundedPrefix(message, TOOL_MAX_BYTES - 100, TOOL_MAX_LINES - 2);
				throw new Error(bounded + (bounded.length < message.length ? "\n[Error message truncated; retry with shorter inputs or narrower scope.]" : ""));
			}
		},

		renderCall(args, theme, context) {
			let display = theme.fg("toolTitle", theme.bold("memory ")) + theme.fg("muted", describeMemoryCall(args));
			if (context.expanded) {
				if (args.action === "append" && args.text) {
					display += `\n\n${theme.fg("toolOutput", args.text)}`;
				} else if (args.action === "replace") {
					display += `\n\n${theme.fg("dim", "old:")}\n${theme.fg("toolOutput", args.oldText ?? "")}`;
					display += `\n${theme.fg("dim", "new:")}\n${theme.fg("toolOutput", args.newText ?? "")}`;
				}
			}
			return new Text(display, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as MemoryToolDetails | undefined;
			const content = textContent(result.content);
			if (!details) return new Text(content, 0, 0);

			const failed = _context.isError || /^Error:/i.test(content) || /nothing (?:was )?written/i.test(content);
			let summary: string;
			switch (details.action) {
				case "read":
					summary = `Read ${details.files.length} memory file${details.files.length === 1 ? "" : "s"}`;
					break;
				case "audit":
					summary = "Memory metadata audit";
					break;
				case "search":
					summary = `Found ${details.count ?? 0} match${details.count === 1 ? "" : "es"} across ${details.files.length} file${details.files.length === 1 ? "" : "s"}`;
					break;
				default:
					summary = content.split("\n", 1)[0] || `${details.action} completed`;
			}

			const color = failed ? "error" : "success";
			let display = theme.fg(color, `${failed ? "✗" : "✓"} ${summary}`);
			for (const file of details.files) display += `\n  ${theme.fg("dim", compactMemoryPath(file))}`;

			// Keep the settled row compact, but expose actual read/search output when
			// the user expands tool details. Mutation summaries are already visible.
			if (expanded && (details.action === "read" || details.action === "search" || details.action === "audit" || failed) && content) {
				display += `\n\n${theme.fg("toolOutput", content)}`;
			}
			return new Text(display, 0, 0);
		},
	});
}
