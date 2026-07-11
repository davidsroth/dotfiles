import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Type } from "typebox";

const EXTENSION_NAME = "pi-memory";
const INJECT_MAX_CHARS = 12_000;
const TOOL_READ_MAX_CHARS = 50_000;

const TARGETS = ["memory", "scratchpad", "daily", "all"] as const;
const ACTIONS = ["read", "search", "append", "replace", "scratch_done"] as const;
const SCOPES = ["global", "local", "project"] as const;

type Target = (typeof TARGETS)[number];
type Action = (typeof ACTIONS)[number];
type Scope = (typeof SCOPES)[number];

type MemoryParams = {
	action: Action;
	target?: Target;
	scope?: Scope;
	text?: string;
	query?: string;
	oldText?: string;
	newText?: string;
	limit?: number;
	section?: string;
};

type MemoryDataParams = Omit<MemoryParams, "action"> & { action?: Action };

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

const MemoryParamsSchema = Type.Object({
	action: StringEnum(ACTIONS),
	target: Type.Optional(
		StringEnum(TARGETS, {
			description: "Which memory file to operate on. Use all only for read.",
		}),
	),
	text: Type.Optional(Type.String({ description: "Text to append, or scratchpad item text/query." })),
	query: Type.Optional(Type.String({ description: "Search query or scratchpad item query." })),
	oldText: Type.Optional(Type.String({ description: "Exact text to replace." })),
	newText: Type.Optional(Type.String({ description: "Replacement text." })),
	limit: Type.Optional(Type.Number({ description: "Maximum search results to return." })),
	section: Type.Optional(
		Type.String({
			description:
				"For target=memory only: the '##' section heading to append a block under (created at EOF if missing), or to read in isolation. Ignored for daily/scratchpad.",
		}),
	),
	scope: Type.Optional(
		StringEnum(SCOPES, {
			description:
				"For target=memory only: 'global' (default) = MEMORY.md, synced across machines; 'local' = MEMORY.local.md, specific to this machine; 'project' = <repo>/.pi/memory/MEMORY.md, scoped to the current project/repo and travels with the working tree. Ignored for daily/scratchpad.",
		}),
	),
});

const defaultMemoryTemplate = `# Long-term memory

Stable facts and preferences that should influence future pi sessions.

## User preferences

- Prefer concise, practical, evidence-based answers.
- Prefer small, targeted code changes.

## Environment

- Primary shell: zsh.
- Primary editor: Neovim.
- Primary terminal: WezTerm.

## Other
`;

const defaultMemoryLocalTemplate = `# This-machine memory

Facts and context specific to THIS machine (not synced across machines).
Use this for machine-bound paths, the role of this machine (e.g. work vs
personal), and project/operational context that only applies here.

## Machine

## Other
`;

const defaultScratchpadTemplate = `# Memory scratchpad

Checklist of possible follow-ups, unresolved issues, and candidate memories.

- [ ] Review and prune this scratchpad periodically.
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

const getAgentDir = (): string => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

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
	const projectDir = join(projectRoot, ".pi", "memory");
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

// Resolve the MEMORY file for a scope. Global (default) syncs across machines;
// local stays on this machine; project lives in the current repo's .pi/memory/.
export const memoryPathForScope = (paths: StorePaths, scope: Scope | undefined): string =>
	scope === "local" ? paths.memoryLocal : scope === "project" ? paths.project : paths.memory;

const ensurePrivateDirectory = async (path: string): Promise<void> => {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
};

const tightenPrivateFile = async (path: string): Promise<void> => {
	const info = await lstat(path);
	// Global MEMORY.md may intentionally be a symlink to a public dotfiles repo;
	// never chmod through it and unexpectedly mutate the tracked target.
	if (!info.isSymbolicLink() && info.isFile()) await chmod(path, 0o600);
};

const writeFileIfMissing = async (path: string, content: string): Promise<void> => {
	await ensurePrivateDirectory(dirname(path));
	try {
		await writeFile(path, content, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	await tightenPrivateFile(path);
};

// NOTE: deliberately does NOT create the project file — that would litter every
// repo the user opens. Project memory is created lazily on first scope=project write.
export const ensureStore = async (cwd?: string): Promise<StorePaths> => {
	const paths = getStorePaths(cwd);
	await ensurePrivateDirectory(paths.dir);
	await ensurePrivateDirectory(paths.dailyDir);
	await writeFileIfMissing(paths.memory, defaultMemoryTemplate);
	await writeFileIfMissing(paths.memoryLocal, defaultMemoryLocalTemplate);
	await writeFileIfMissing(paths.scratchpad, defaultScratchpadTemplate);
	return paths;
};

const ensureDailyFile = async (paths: StorePaths): Promise<void> => {
	const day = todayString();
	await writeFileIfMissing(paths.today, `# ${day}\n`);
};

const readTextFile = async (path: string): Promise<string> => readFile(path, "utf8");

export const truncateText = (text: string, maxChars: number): { text: string; truncated: boolean } => {
	if (text.length <= maxChars) return { text, truncated: false };
	return {
		text: `${text.slice(0, maxChars)}\n\n[Truncated ${text.length - maxChars} character(s). Use memory search/read more specifically if needed.]`,
		truncated: true,
	};
};

export const headingLevel = (line: string): number => {
	const match = /^(#{1,6})\s/.exec(line);
	return match ? (match[1] as string).length : 0;
};

export const headingText = (line: string): string => line.replace(/^#{1,6}\s+/, "").trim();

// Parse ATX headings, skipping lines inside ``` / ~~~ fenced code blocks so a
// "# comment" in a shell example isn't mistaken for a section heading.
export const parseHeadings = (lines: string[]): { index: number; level: number; title: string }[] => {
	const out: { index: number; level: number; title: string }[] = [];
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const fenceMatch = /^\s*(```|~~~)/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1] as string;
			fence = fence === null ? marker : fence === marker ? null : fence;
			continue;
		}
		if (fence !== null) continue;
		const level = headingLevel(line);
		if (level > 0) out.push({ index: i, level, title: headingText(line) });
	}
	return out;
};

// Range of a Markdown section: [heading line, next heading of same-or-higher level).
export const findSectionRange = (lines: string[], section: string): { start: number; end: number; level: number } | null => {
	const heads = parseHeadings(lines);
	const needle = section.trim().toLowerCase();
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
	const paths = await ensureStore(cwd);
	const resolved = target ?? "memory";
	if (resolved === "memory") return { paths, path: memoryPathForScope(paths, scope) };
	if (resolved === "scratchpad") return { paths, path: paths.scratchpad };
	if (resolved === "daily") {
		await ensureDailyFile(paths);
		return { paths, path: paths.today };
	}
	return { paths };
};

const listMarkdownFiles = async (dir: string): Promise<string[]> => {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...(await listMarkdownFiles(path)));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			out.push(path);
		}
	}
	return out.sort();
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
		await ensureDailyFile(paths);
		const files = [paths.memory, paths.memoryLocal, paths.scratchpad, paths.today];
		if (existsSync(paths.project)) files.push(paths.project);
		const blocks = await Promise.all(
			files.map(async (file) => formatFileBlock(file === paths.project ? paths.projectRoot : paths.dir, file, await readTextFile(file))),
		);
		return { text: blocks.join("\n\n---\n\n"), files };
	}
	if (!path) throw new Error("No path resolved for target");
	if (scope === "project" && !existsSync(path)) {
		return { text: `No project memory yet at ${path}. Append with scope="project" to create it.`, files: [path] };
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
	if (!path) return { text: "Error: section read requires target memory, scratchpad, or daily.", files: [] };
	if ((target ?? "memory") === "daily") await ensureDailyFile(paths);
	if (scope === "project" && !existsSync(path)) return { text: `No project memory yet at ${path}.`, files: [path] };
	const content = await readTextFile(path);
	const lines = content.split("\n");
	const range = findSectionRange(lines, section);
	if (!range) {
		return {
			text: `Error: section "${section}" not found in ${displayPath(paths, path)}.\n\nAvailable sections:\n${buildOutline(content)}`,
			files: [path],
		};
	}
	return { text: lines.slice(range.start, range.end).join("\n").trimEnd(), files: [path] };
};

export const searchMemory = async (params: MemoryDataParams, cwd?: string): Promise<{ text: string; files: string[]; count: number }> => {
	const query = params.query?.trim() || params.text?.trim();
	if (!query) return { text: "Error: query is required for memory search.", files: [], count: 0 };

	const paths = await ensureStore(cwd);
	// Scan the central store plus the current project's memory file (labelled
	// relative to its own root so crumbs stay readable).
	const scanned: { file: string; root: string }[] = (await listMarkdownFiles(paths.dir)).map((file) => ({ file, root: paths.dir }));
	if (existsSync(paths.project)) scanned.push({ file: paths.project, root: paths.projectRoot });
	const files = scanned.map((entry) => entry.file);
	const needle = query.toLowerCase();
	const limit = Math.min(Math.max(Math.floor(params.limit ?? 30), 1), 100);
	const matches: string[] = [];

	for (const { file, root } of scanned) {
		const rel = relative(root, file);
		const lines = (await readTextFile(file)).split("\n");
		const headByIndex = new Map(parseHeadings(lines).map((head) => [head.index, head]));
		const stack: { level: number; title: string }[] = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			const head = headByIndex.get(i);
			if (head) {
				while (stack.length && (stack[stack.length - 1]?.level ?? 0) >= head.level) stack.pop();
				stack.push({ level: head.level, title: head.title });
			}
			if (!line.toLowerCase().includes(needle)) continue;
			const crumb = stack.map((s) => s.title).join(" \u203a ");
			const loc = crumb ? `${rel} \u203a ${crumb}:${i + 1}` : `${rel}:${i + 1}`;
			matches.push(`${loc}: ${line}`);
			if (matches.length >= limit) {
				return {
					text: `${matches.join("\n")}\n\n[Search truncated at ${limit} result(s).]`,
					files,
					count: matches.length,
				};
			}
		}
	}

	return {
		text: matches.length ? matches.join("\n") : `No memory matches for: ${query}`,
		files,
		count: matches.length,
	};
};

export const appendToTarget = async (params: MemoryDataParams, cwd?: string): Promise<{ text: string; files: string[] }> => {
	const target = params.target;
	const text = params.text?.trim();
	if (!text) return { text: "Error: text is required for append.", files: [] };
	if (!target || target === "all") return { text: "Error: target must be memory, scratchpad, or daily for append.", files: [] };

	const { paths, path } = await resolveTargetPath(target, params.scope, cwd);
	if (!path) throw new Error("No path resolved for append target");
	if (target === "daily") await ensureDailyFile(paths);

	let resultText = `Appended to ${displayPath(paths, path)}.`;

	await withFileMutationQueue(path, async () => {
		await ensurePrivateDirectory(dirname(path));
		let current = "";
		try {
			current = await readTextFile(path);
		} catch {
			current = "";
		}

		if (target === "memory") {
			// Memory is structured Markdown. Append a well-formed block (no bullet
			// wrapper, which would accrete as stray "- ..." / "- ##" lines) and place
			// it under `section` when given, creating the section at EOF if missing.
			const block = text.replace(/\s+$/, "");
			const sectionName = params.section?.trim();
			if (sectionName) {
				// `section` targets an EXISTING heading only. On a miss we do NOT
				// silently create a section (a typo would fragment the file); the
				// caller creates one by appending a block that starts with `## Title`
				// and no `section`.
				const lines = current.split("\n");
				const range = findSectionRange(lines, sectionName);
				if (!range) {
					resultText =
						`Section "${sectionName}" not found in ${displayPath(paths, path)} \u2014 nothing written.\n` +
						`Existing sections:\n${buildOutline(current)}\n` +
						`To create a new section, append a block whose first line is "## ${sectionName}" and omit \`section\`.`;
					return;
				}
				let insertAt = range.end;
				while (insertAt > range.start + 1 && (lines[insertAt - 1] ?? "").trim() === "") insertAt--;
				lines.splice(insertAt, 0, "", block, "");
				await writeFile(path, lines.join("\n"), "utf8");
				resultText = `Appended under "${sectionName}" in ${displayPath(paths, path)}.`;
			} else {
				const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
				await writeFile(path, `${current}${sep}\n${block}\n`, "utf8");
			}
			return;
		}

		const entry = target === "scratchpad" ? `- [ ] ${text}\n` : `- ${timeString()} — ${text}\n`;
		const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
		await writeFile(path, `${current}${separator}${entry}`, "utf8");
	});

	return { text: resultText, files: [path] };
};

export const replaceInTarget = async (params: MemoryDataParams, cwd?: string): Promise<{ text: string; files: string[] }> => {
	const target = params.target ?? "memory";
	if (target === "daily" || target === "all") {
		return { text: "Error: replace is only allowed for memory or scratchpad. Daily logs are append-only.", files: [] };
	}
	if (!params.oldText) return { text: "Error: oldText is required for replace.", files: [] };
	if (params.newText === undefined) return { text: "Error: newText is required for replace.", files: [] };

	const { paths, path } = await resolveTargetPath(target, params.scope, cwd);
	if (!path) throw new Error("No path resolved for replace target");
	if (!existsSync(path)) return { text: `Error: ${path} does not exist yet — nothing to replace.`, files: [path] };

	let replacementCount = 0;
	await withFileMutationQueue(path, async () => {
		const current = await readTextFile(path);
		replacementCount = current.split(params.oldText as string).length - 1;
		if (replacementCount !== 1) return;
		await writeFile(path, current.replace(params.oldText as string, params.newText as string), "utf8");
	});

	if (replacementCount === 0) return { text: `Error: oldText was not found in ${displayPath(paths, path)}.`, files: [path] };
	if (replacementCount > 1) {
		return {
			text: `Error: oldText matched ${replacementCount} times in ${displayPath(paths, path)}. Use a more specific oldText.`,
			files: [path],
		};
	}
	return { text: `Replaced one occurrence in ${displayPath(paths, path)}.`, files: [path] };
};

export const markScratchDone = async (params: MemoryDataParams): Promise<{ text: string; files: string[] }> => {
	const query = params.query?.trim() || params.text?.trim();
	if (!query) return { text: "Error: query or text is required for scratch_done.", files: [] };

	const { paths } = await resolveTargetPath("scratchpad");
	const path = paths.scratchpad;
	let result = "";

	await withFileMutationQueue(path, async () => {
		const current = await readTextFile(path);
		const lines = current.split("\n");
		const needle = query.toLowerCase();
		const matches: number[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			if (!/^\s*-\s+\[ \]\s+/.test(line)) continue;
			if (line.toLowerCase().includes(needle)) matches.push(i);
		}

		if (matches.length === 0) {
			result = `Error: no incomplete scratchpad item matched: ${query}`;
			return;
		}
		if (matches.length > 1) {
			result = `Error: ${matches.length} scratchpad items matched. Use a more specific query:\n${matches
				.map((index) => lines[index])
				.join("\n")}`;
			return;
		}

		const index = matches[0] as number;
		lines[index] = (lines[index] as string).replace(/^(\s*-\s+)\[ \](\s+)/, "$1[x]$2");
		await writeFile(path, lines.join("\n"), "utf8");
		result = `Marked scratchpad item done: ${lines[index]}`;
	});

	return { text: result, files: [path] };
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

export default function memoryExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			await ensureStore();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`${EXTENSION_NAME}: failed to initialize memory store: ${message}`, "error");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const paths = await ensureStore(ctx.cwd);

		// Render one MEMORY file into a labeled prompt section, truncating with an
		// outline fallback so a large file still exposes its section map.
		const renderBlock = async (path: string, heading: string, source: string, intro: string): Promise<string | null> => {
			let raw = "";
			try {
				raw = (await readTextFile(path)).trim();
			} catch {
				raw = "";
			}
			if (!raw) return null;
			const truncated = truncateText(raw, INJECT_MAX_CHARS);
			let body = truncated.text;
			if (truncated.truncated) {
				body += `\n\n### Memory outline (full section map — call the \`memory\` tool with action=read${source ? `, ${source},` : ""} and \`section\` to load any of these)\n${buildOutline(raw)}`;
			}
			return [heading, "", intro, "", body].join("\n");
		};

		const blocks = (
			await Promise.all([
				renderBlock(
					paths.memory,
					"## Long-term user memory (global)",
					"scope=global",
					"The following content is from `~/.pi/agent/memory/MEMORY.md` (synced across machines). Treat it as persistent user memory unless the user says otherwise.",
				),
				renderBlock(
					paths.memoryLocal,
					"## This-machine memory (local)",
					"scope=local",
					"The following content is from `~/.pi/agent/memory/MEMORY.local.md` (specific to THIS machine, not synced). Treat it as persistent machine-local context.",
				),
				renderBlock(
					paths.project,
					"## Project memory (this repo)",
					"scope=project",
					`The following content is from this project's memory file at \`${paths.project}\` (scope=project; specific to this repo/working tree, not synced globally). Treat it as persistent project context.`,
				),
			])
		).filter((block): block is string => block !== null);

		if (blocks.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${blocks.join("\n\n")}` };
	});

	pi.registerCommand("memory", {
		description: "Show pi-memory storage paths (/memory [memory|scratchpad|daily|dir])",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
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
			"Read and update filesystem-backed persistent memory under ~/.pi/agent/memory/. " +
			"Use for durable preferences, recurring facts, decisions, discoveries, and follow-up reminders.",
		promptSnippet: "Read or update persistent Markdown memory files under ~/.pi/agent/memory/",
		promptGuidelines: [
			"Use memory opportunistically when durable preferences, recurring facts, decisions, discoveries, or follow-up tasks would help future pi sessions.",
			"Use memory target=memory for stable long-term facts/preferences; target=scratchpad for uncertain reminders or cleanup items; target=daily for timestamped session facts, decisions, and discoveries.",
			"For target=memory, choose scope: omit/scope=global for portable facts that apply across all machines and contexts (preferences, general tooling/process lessons); scope=local for facts specific to THIS machine (its role e.g. work vs personal, machine-bound paths); scope=project for facts tied to the CURRENT repo/project (architecture, build commands, project-specific gotchas) — stored in <repo>/.pi/memory/MEMORY.md, which travels with the working tree. Global is committed+synced; local stays on this machine; project lives in the repo.",
			"When appending to target=memory, pass a well-formed Markdown block (e.g. a `### Title` heading plus body). Set `section` to an EXISTING `##` heading to insert under it; if the section doesn't exist the append is rejected (with the section list) rather than fragmenting the file. To create a new section, append a block whose first line is `## Title` and omit `section`. Don't append bare bullets or `- ##` headers.",
			"To inspect part of a large MEMORY.md, call read with `section=\"<## heading>\"` rather than reading the whole file; a read that truncates appends an outline of available sections.",
			"Use memory search/read before adding long-term memory when duplication or conflict is likely.",
			"Do not store secrets, credentials, private tokens, or highly ephemeral implementation details in memory.",
		],
		parameters: MemoryParamsSchema,
		async execute(_toolCallId, params: MemoryParams, _signal, _onUpdate, ctx) {
			let output: { text: string; files: string[]; count?: number };
			const cwd = ctx?.cwd;

			switch (params.action) {
				case "read": {
					if (params.section?.trim() && (params.target ?? "memory") !== "all") {
						const result = await readSection(params.target, params.section.trim(), params.scope, cwd);
						const truncated = truncateText(result.text, TOOL_READ_MAX_CHARS);
						output = { text: truncated.text, files: result.files };
						break;
					}
					const result = await readTarget(params.target, params.scope, cwd);
					const truncated = truncateText(result.text, TOOL_READ_MAX_CHARS);
					const text =
						truncated.truncated && (params.target ?? "memory") === "memory"
							? `${truncated.text}\n\n## Outline (call read with section="<heading>" to load one section)\n${buildOutline(result.text)}`
							: truncated.text;
					output = { text, files: result.files };
					break;
				}
				case "search":
					output = await searchMemory(params, cwd);
					break;
				case "append":
					output = await appendToTarget(params, cwd);
					break;
				case "replace":
					output = await replaceInTarget(params, cwd);
					break;
				case "scratch_done":
					output = await markScratchDone(params);
					break;
				default:
					output = { text: `Error: unsupported memory action ${(params as { action?: string }).action}`, files: [] };
			}

			return {
				content: [{ type: "text", text: output.text }],
				details: {
					action: params.action,
					target: params.target,
					scope: params.scope,
					files: output.files,
					count: output.count,
				},
			};
		},
	});
}
