import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Type } from "typebox";

const EXTENSION_NAME = "pi-memory";
const INJECT_MAX_CHARS = 12_000;
const TOOL_READ_MAX_CHARS = 50_000;

const TARGETS = ["memory", "scratchpad", "daily", "all"] as const;
const ACTIONS = ["read", "search", "append", "replace", "scratch_done"] as const;

type Target = (typeof TARGETS)[number];
type Action = (typeof ACTIONS)[number];

type MemoryParams = {
	action: Action;
	target?: Target;
	text?: string;
	query?: string;
	oldText?: string;
	newText?: string;
	limit?: number;
};

type StorePaths = {
	dir: string;
	dailyDir: string;
	memory: string;
	scratchpad: string;
	today: string;
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

const defaultScratchpadTemplate = `# Memory scratchpad

Checklist of possible follow-ups, unresolved issues, and candidate memories.

- [ ] Review and prune this scratchpad periodically.
`;

const todayString = (date = new Date()): string => {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
};

const timeString = (date = new Date()): string => {
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
};

const getAgentDir = (): string => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

const getStorePaths = (): StorePaths => {
	const dir = join(getAgentDir(), "memory");
	const dailyDir = join(dir, "daily");
	const today = todayString();
	return {
		dir,
		dailyDir,
		memory: join(dir, "MEMORY.md"),
		scratchpad: join(dir, "SCRATCHPAD.md"),
		today: join(dailyDir, `${today}.md`),
	};
};

const writeFileIfMissing = async (path: string, content: string): Promise<void> => {
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(path, content, { flag: "wx" });
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return;
		throw error;
	}
};

const ensureStore = async (): Promise<StorePaths> => {
	const paths = getStorePaths();
	await mkdir(paths.dailyDir, { recursive: true });
	await writeFileIfMissing(paths.memory, defaultMemoryTemplate);
	await writeFileIfMissing(paths.scratchpad, defaultScratchpadTemplate);
	return paths;
};

const ensureDailyFile = async (paths: StorePaths): Promise<void> => {
	const day = todayString();
	await writeFileIfMissing(paths.today, `# ${day}\n`);
};

const readTextFile = async (path: string): Promise<string> => readFile(path, "utf8");

const truncateText = (text: string, maxChars: number): { text: string; truncated: boolean } => {
	if (text.length <= maxChars) return { text, truncated: false };
	return {
		text: `${text.slice(0, maxChars)}\n\n[Truncated ${text.length - maxChars} character(s). Use memory search/read more specifically if needed.]`,
		truncated: true,
	};
};

const resolveTargetPath = async (target: Target | undefined): Promise<{ paths: StorePaths; path?: string }> => {
	const paths = await ensureStore();
	const resolved = target ?? "memory";
	if (resolved === "memory") return { paths, path: paths.memory };
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

const readTarget = async (target: Target | undefined): Promise<{ text: string; files: string[] }> => {
	const { paths, path } = await resolveTargetPath(target);
	if ((target ?? "memory") === "all") {
		await ensureDailyFile(paths);
		const files = [paths.memory, paths.scratchpad, paths.today];
		const blocks = await Promise.all(files.map(async (file) => formatFileBlock(paths.dir, file, await readTextFile(file))));
		return { text: blocks.join("\n\n---\n\n"), files };
	}
	if (!path) throw new Error("No path resolved for target");
	return { text: await readTextFile(path), files: [path] };
};

const searchMemory = async (params: MemoryParams): Promise<{ text: string; files: string[]; count: number }> => {
	const query = params.query?.trim() || params.text?.trim();
	if (!query) return { text: "Error: query is required for memory search.", files: [], count: 0 };

	const paths = await ensureStore();
	const files = await listMarkdownFiles(paths.dir);
	const needle = query.toLowerCase();
	const limit = Math.min(Math.max(Math.floor(params.limit ?? 30), 1), 100);
	const matches: string[] = [];

	for (const file of files) {
		const rel = relative(paths.dir, file);
		const lines = (await readTextFile(file)).split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			if (!line.toLowerCase().includes(needle)) continue;
			matches.push(`${rel}:${i + 1}: ${line}`);
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

const appendToTarget = async (params: MemoryParams): Promise<{ text: string; files: string[] }> => {
	const target = params.target;
	const text = params.text?.trim();
	if (!text) return { text: "Error: text is required for append.", files: [] };
	if (!target || target === "all") return { text: "Error: target must be memory, scratchpad, or daily for append.", files: [] };

	const { paths, path } = await resolveTargetPath(target);
	if (!path) throw new Error("No path resolved for append target");
	if (target === "daily") await ensureDailyFile(paths);

	const entry =
		target === "scratchpad" ? `- [ ] ${text}\n` : target === "daily" ? `- ${timeString()} — ${text}\n` : `- ${text}\n`;

	await withFileMutationQueue(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		let current = "";
		try {
			current = await readTextFile(path);
		} catch {
			current = "";
		}
		const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
		await writeFile(path, `${current}${separator}${entry}`, "utf8");
	});

	return { text: `Appended to ${relative(paths.dir, path)}.`, files: [path] };
};

const replaceInTarget = async (params: MemoryParams): Promise<{ text: string; files: string[] }> => {
	const target = params.target ?? "memory";
	if (target === "daily" || target === "all") {
		return { text: "Error: replace is only allowed for memory or scratchpad. Daily logs are append-only.", files: [] };
	}
	if (!params.oldText) return { text: "Error: oldText is required for replace.", files: [] };
	if (params.newText === undefined) return { text: "Error: newText is required for replace.", files: [] };

	const { paths, path } = await resolveTargetPath(target);
	if (!path) throw new Error("No path resolved for replace target");

	let replacementCount = 0;
	await withFileMutationQueue(path, async () => {
		const current = await readTextFile(path);
		replacementCount = current.split(params.oldText as string).length - 1;
		if (replacementCount !== 1) return;
		await writeFile(path, current.replace(params.oldText as string, params.newText as string), "utf8");
	});

	if (replacementCount === 0) return { text: `Error: oldText was not found in ${relative(paths.dir, path)}.`, files: [path] };
	if (replacementCount > 1) {
		return {
			text: `Error: oldText matched ${replacementCount} times in ${relative(paths.dir, path)}. Use a more specific oldText.`,
			files: [path],
		};
	}
	return { text: `Replaced one occurrence in ${relative(paths.dir, path)}.`, files: [path] };
};

const markScratchDone = async (params: MemoryParams): Promise<{ text: string; files: string[] }> => {
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

const buildCommandPathMessage = async (target: string | undefined): Promise<string> => {
	const paths = await ensureStore();
	const normalized = target?.trim().toLowerCase();
	if (normalized === "memory" || normalized === "memory.md") return paths.memory;
	if (normalized === "scratchpad" || normalized === "scratchpad.md") return paths.scratchpad;
	if (normalized === "daily" || normalized === "today" || normalized === "today daily") {
		await ensureDailyFile(paths);
		return paths.today;
	}
	if (normalized === "dir" || normalized === "directory") return paths.dir;
	return [
		`Memory directory: ${paths.dir}`,
		`MEMORY.md: ${paths.memory}`,
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

	pi.on("before_agent_start", async (event) => {
		const paths = await ensureStore();
		const memory = (await readTextFile(paths.memory)).trim();
		if (!memory) return;

		const truncated = truncateText(memory, INJECT_MAX_CHARS);
		const suffix = [
			"## Long-term user memory",
			"",
			"The following content is from `~/.pi/agent/memory/MEMORY.md`. Treat it as persistent user memory unless the user says otherwise.",
			"",
			truncated.text,
		].join("\n");

		return { systemPrompt: `${event.systemPrompt}\n\n${suffix}` };
	});

	pi.registerCommand("memory", {
		description: "Show pi-memory storage paths (/memory [memory|scratchpad|daily|dir])",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			let target = trimmed;
			if (!target && ctx.hasUI) {
				const choice = await ctx.ui.select("Memory", ["directory", "MEMORY.md", "SCRATCHPAD.md", "today daily"]);
				if (!choice) return;
				target = choice;
			}
			const message = await buildCommandPathMessage(target);
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
			"Use memory search/read before adding long-term memory when duplication or conflict is likely.",
			"Do not store secrets, credentials, private tokens, or highly ephemeral implementation details in memory.",
		],
		parameters: MemoryParamsSchema,
		async execute(_toolCallId, params: MemoryParams) {
			let output: { text: string; files: string[]; count?: number };

			switch (params.action) {
				case "read": {
					const result = await readTarget(params.target);
					const truncated = truncateText(result.text, TOOL_READ_MAX_CHARS);
					output = { text: truncated.text, files: result.files };
					break;
				}
				case "search":
					output = await searchMemory(params);
					break;
				case "append":
					output = await appendToTarget(params);
					break;
				case "replace":
					output = await replaceInTarget(params);
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
					files: output.files,
					count: output.count,
				},
			};
		},
	});
}
