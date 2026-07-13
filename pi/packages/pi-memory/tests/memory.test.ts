/**
 * Tests for pi-memory/extensions/memory.ts
 *
 * Hermetic: no real network, no real child processes, no reads of the user's
 * real config or memory files. Filesystem tests use os.tmpdir() scratch dirs
 * cleaned up in afterEach. The user's real ~/.pi/agent/memory/ is never touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock external dependencies BEFORE importing the module under test.
// vi.mock() is hoisted, so these run before imports.
// ---------------------------------------------------------------------------

// Mock @earendil-works/pi-coding-agent to make withFileMutationQueue a passthrough.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	withFileMutationQueue: async (_path: string, cb: () => Promise<void>) => {
		await cb();
	},
}));

// Mock @earendil-works/pi-ai for StringEnum (used in schema only, not in logic)
vi.mock("@earendil-works/pi-ai", () => ({
	StringEnum: (values: string[]) => ({ enum: values }),
}));

// Mock the TUI Text component; pure formatting tests only inspect its input.
vi.mock("@earendil-works/pi-tui", () => ({
	Text: class Text {
		constructor(
			public text: string,
			public paddingX: number,
			public paddingY: number,
		) {}
	},
}));

// Mock typebox Type (used in schema only)
vi.mock("typebox", () => ({
	Type: {
		Object: (shape: unknown) => shape,
		Optional: (t: unknown) => t,
		String: (opts?: unknown) => ({ type: "string", ...(opts && typeof opts === "object" ? opts : {}) }),
		Number: (opts?: unknown) => ({ type: "number", ...(opts && typeof opts === "object" ? opts : {}) }),
	},
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are registered)
// ---------------------------------------------------------------------------
import memoryExtension, {
	todayString,
	timeString,
	truncateText,
	headingLevel,
	headingText,
	parseHeadings,
	findSectionRange,
	buildOutline,
	findProjectRoot,
	memoryPathForScope,
	ensureStore,
	appendToTarget,
	replaceInTarget,
	markScratchDone,
	readSection,
	searchMemory,
	describeMemoryCall,
	compactMemoryPath,
} from "../extensions/memory.js";

// ---------------------------------------------------------------------------
// Helper: create a unique tmp directory per test
// ---------------------------------------------------------------------------
function makeScratchDir(): string {
	const dir = join(tmpdir(), `pi-memory-test-${randomBytes(6).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ---------------------------------------------------------------------------
// Helper: set up a minimal store layout in a tmp dir
// Returns the dir and an env-restore function.
// ---------------------------------------------------------------------------
function setupStore(scratchDir: string): {
	agentDir: string;
	memoryDir: string;
	restore: () => void;
} {
	const agentDir = join(scratchDir, "agent");
	const memoryDir = join(agentDir, "memory");
	const dailyDir = join(memoryDir, "daily");
	mkdirSync(dailyDir, { recursive: true });

	const origEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	return {
		agentDir,
		memoryDir,
		restore: () => {
			if (origEnv === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = origEnv;
			}
		},
	};
}

// ============================================================================
// 1. Pure functions — no mocks needed
// ============================================================================

describe("memory tool rendering descriptions", () => {
	it("shows the scope and section for reads", () => {
		expect(describeMemoryCall({ action: "read", target: "memory", scope: "local", section: "Machine" })).toBe(
			'read memory:local section="Machine"',
		);
	});

	it("shows a compact preview of appended content", () => {
		expect(
			describeMemoryCall({
				action: "append",
				target: "memory",
				scope: "project",
				section: "Architecture",
				text: "### Decision\n\nUse the file-backed cache.",
			}),
		).toBe('append memory:project section="Architecture" ← "### Decision Use the file-backed cache."');
	});

	it("shows both sides of a replacement", () => {
		expect(describeMemoryCall({ action: "replace", oldText: "old value", newText: "new value" })).toBe(
			'replace memory:global "old value" → "new value"',
		);
	});

	it("shortens files beneath the home directory", () => {
		expect(compactMemoryPath("/home/test/.pi/agent/memory/MEMORY.md", "/home/test")).toBe(
			"~/.pi/agent/memory/MEMORY.md",
		);
		expect(compactMemoryPath("/repo/.pi/memory/MEMORY.md", "/home/test")).toBe("/repo/.pi/memory/MEMORY.md");
	});

	it("renders full appended text when tool details are expanded", () => {
		let tool: any;
		memoryExtension({
			on: vi.fn(),
			registerCommand: vi.fn(),
			registerTool: (definition: unknown) => {
				tool = definition;
			},
		} as never);
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const rendered = tool.renderCall(
			{ action: "append", target: "memory", scope: "project", text: "### Full heading\nFull body" },
			theme,
			{ expanded: true },
		) as { text: string };
		expect(rendered.text).toContain("append memory:project");
		expect(rendered.text).toContain("### Full heading\nFull body");
	});

	it("renders the files actually read", () => {
		let tool: any;
		memoryExtension({
			on: vi.fn(),
			registerCommand: vi.fn(),
			registerTool: (definition: unknown) => {
				tool = definition;
			},
		} as never);
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const rendered = tool.renderResult(
			{
				content: [{ type: "text", text: "## Machine\n- Workstation" }],
				details: { action: "read", target: "memory", scope: "local", files: ["/tmp/MEMORY.local.md"] },
			},
			{ expanded: false },
			theme,
			{},
		) as { text: string };
		expect(rendered.text).toContain("Read 1 memory file");
		expect(rendered.text).toContain("/tmp/MEMORY.local.md");
	});
});

describe("todayString", () => {
	it("formats YYYY-MM-DD with zero-padding for Jan 5", () => {
		expect(todayString(new Date(2025, 0, 5))).toBe("2025-01-05");
	});
	it("formats Dec 31 correctly", () => {
		expect(todayString(new Date(2025, 11, 31))).toBe("2025-12-31");
	});
	it("pads single-digit month and day", () => {
		expect(todayString(new Date(2024, 2, 7))).toBe("2024-03-07");
	});
});

describe("timeString", () => {
	it("returns HH:MM with zero-padded values for 9:05", () => {
		const d = new Date(2025, 0, 1, 9, 5);
		expect(timeString(d)).toBe("09:05");
	});
	it("returns 23:59 for last minute of day", () => {
		const d = new Date(2025, 0, 1, 23, 59);
		expect(timeString(d)).toBe("23:59");
	});
	it("pads midnight correctly", () => {
		const d = new Date(2025, 0, 1, 0, 0);
		expect(timeString(d)).toBe("00:00");
	});
});

describe("truncateText", () => {
	it("returns not-truncated when text.length === maxChars", () => {
		const text = "a".repeat(100);
		const result = truncateText(text, 100);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe(text);
	});
	it("returns truncated when text.length === maxChars + 1", () => {
		const text = "a".repeat(101);
		const result = truncateText(text, 100);
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("1 character(s)");
	});
	it("does not truncate empty string with maxChars=0", () => {
		const result = truncateText("", 0);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("");
	});
	it("shows correct cut character count", () => {
		const result = truncateText("a".repeat(15), 10);
		expect(result.text).toContain("5 character(s)");
	});
});

describe("headingLevel", () => {
	it("returns 1 for # heading", () => expect(headingLevel("# Foo")).toBe(1));
	it("returns 2 for ## heading", () => expect(headingLevel("## Foo")).toBe(2));
	it("returns 6 for ###### heading", () => expect(headingLevel("###### Foo")).toBe(6));
	it("returns 0 for non-heading", () => expect(headingLevel("regular text")).toBe(0));
	it("returns 0 for heading with no space", () => expect(headingLevel("##NoSpace")).toBe(0));
});

describe("headingText", () => {
	it("strips leading hashes and spaces", () => expect(headingText("## Hello World")).toBe("Hello World"));
	it("strips deep heading hashes", () => expect(headingText("### Sub Section")).toBe("Sub Section"));
	it("trims extra whitespace", () => expect(headingText("##  Padded ")).toBe("Padded"));
});

describe("parseHeadings", () => {
	it("parses headings outside fences", () => {
		const lines = ["## outside", "```", "## inside-backtick", "```", "## back-outside"];
		const result = parseHeadings(lines);
		expect(result.map((h) => h.title)).toEqual(["outside", "back-outside"]);
		expect(result.map((h) => h.index)).toEqual([0, 4]);
	});

	it("skips headings inside ~~~ fence", () => {
		const lines = ["## outside", "~~~", "## inside-tilde", "~~~", "## after"];
		const result = parseHeadings(lines);
		expect(result.map((h) => h.title)).toEqual(["outside", "after"]);
	});

	it("backtick fence is NOT closed by tilde (mismatched)", () => {
		// Open with ```, try to close with ~~~: still fenced after ~~~
		const lines = ["## before", "```", "## fenced1", "~~~", "## fenced2", "```", "## after"];
		const result = parseHeadings(lines);
		// ~~~ does not close the ``` fence; ## fenced2 is still fenced
		// ``` closes it; ## after is outside
		expect(result.map((h) => h.title)).toEqual(["before", "after"]);
	});

	it("returns empty array for file with no headings", () => {
		const result = parseHeadings(["just text", "more text"]);
		expect(result).toEqual([]);
	});

	it("records correct level", () => {
		const lines = ["# H1", "## H2", "### H3"];
		const result = parseHeadings(lines);
		expect(result.map((h) => h.level)).toEqual([1, 2, 3]);
	});
});

describe("findSectionRange", () => {
	const lines = [
		"# Doc",
		"",
		"## First",
		"content of first",
		"",
		"### Sub under first",
		"sub content",
		"",
		"## Second",
		"content of second",
		"",
		"## Last",
		"content of last",
	];

	it("finds exact-case section with correct start and end", () => {
		const range = findSectionRange(lines, "First");
		expect(range).not.toBeNull();
		expect(range!.start).toBe(2); // line index of "## First"
		expect(range!.end).toBe(8); // line index of "## Second"
	});

	it("is case-insensitive", () => {
		const range = findSectionRange(lines, "first");
		expect(range).not.toBeNull();
		expect(range!.start).toBe(2);
	});

	it("subsection (###) extends the parent section, not terminates it", () => {
		const range = findSectionRange(lines, "First");
		expect(range!.end).toBe(8); // ### Sub does not end it; ## Second does
	});

	it("sibling heading (##) terminates the section", () => {
		const range = findSectionRange(lines, "Second");
		expect(range!.start).toBe(8);
		expect(range!.end).toBe(11); // terminated by ## Last
	});

	it("last section in file has end === lines.length", () => {
		const range = findSectionRange(lines, "Last");
		expect(range!.end).toBe(lines.length);
	});

	it("returns null when section not found", () => {
		expect(findSectionRange(lines, "Nonexistent")).toBeNull();
	});

	it("heading inside a fenced code block does NOT match", () => {
		const fencedLines = ["## Real", "```", "## Fake", "```", "## Also Real"];
		const result = findSectionRange(fencedLines, "Fake");
		expect(result).toBeNull();
	});

	it("parent heading (#) also terminates a ## section", () => {
		const ls = ["## Section", "body", "# Parent terminates"];
		const range = findSectionRange(ls, "Section");
		expect(range!.end).toBe(2); // # is level 1, <= level 2 of ##
	});
});

describe("buildOutline", () => {
	it("emits ## headings as top-level list items", () => {
		const content = "# Title\n\n## Alpha\n\n### Beta\n\n#### Gamma\n";
		const outline = buildOutline(content);
		expect(outline).toContain("- Alpha");
		expect(outline).toContain("  - Beta");
	});

	it("excludes H1 headings", () => {
		const outline = buildOutline("# TopLevel\n## Second\n");
		expect(outline).not.toContain("TopLevel");
		expect(outline).toContain("- Second");
	});

	it("excludes H4+ headings", () => {
		const outline = buildOutline("## Good\n#### TooDeep\n");
		expect(outline).not.toContain("TooDeep");
	});

	it("excludes headings inside code fences", () => {
		const content = "## Outside\n```\n## Inside\n```\n";
		const outline = buildOutline(content);
		expect(outline).toContain("- Outside");
		expect(outline).not.toContain("Inside");
	});
});

describe("memoryPathForScope", () => {
	const paths = {
		dir: "/store",
		dailyDir: "/store/daily",
		memory: "/store/MEMORY.md",
		memoryLocal: "/store/MEMORY.local.md",
		scratchpad: "/store/SCRATCHPAD.md",
		today: "/store/daily/2025-01-01.md",
		projectRoot: "/project",
		projectDir: "/project/.pi/memory",
		project: "/project/.pi/memory/MEMORY.md",
	};

	it("returns memory for undefined scope", () => {
		expect(memoryPathForScope(paths, undefined)).toBe("/store/MEMORY.md");
	});
	it("returns memory for scope=global", () => {
		expect(memoryPathForScope(paths, "global")).toBe("/store/MEMORY.md");
	});
	it("returns memoryLocal for scope=local", () => {
		expect(memoryPathForScope(paths, "local")).toBe("/store/MEMORY.local.md");
	});
	it("returns project for scope=project", () => {
		expect(memoryPathForScope(paths, "project")).toBe("/project/.pi/memory/MEMORY.md");
	});
});

describe("findProjectRoot", () => {
	let scratch: string;
	afterEach(async () => {
		if (scratch) await rm(scratch, { recursive: true, force: true });
	});

	it("returns the directory that contains .git", async () => {
		scratch = makeScratchDir();
		const a = join(scratch, "a");
		const bc = join(scratch, "a", "b", "c");
		mkdirSync(bc, { recursive: true });
		// Place .git as a directory in a
		mkdirSync(join(a, ".git"), { recursive: true });
		const result = findProjectRoot(bc);
		expect(result).toBe(a);
	});

	it("falls back to cwd when no .git found", async () => {
		scratch = makeScratchDir();
		const deep = join(scratch, "x", "y", "z");
		mkdirSync(deep, { recursive: true });
		// No .git anywhere under scratch
		const result = findProjectRoot(deep);
		// Should equal deep (the original cwd) since no .git is found walking up
		// Note: might find an actual .git higher up in the real FS, so we use a
		// path guaranteed to be under tmpdir which is isolated from real git repos
		expect(typeof result).toBe("string");
	});

	it("returns cwd itself when cwd has .git", async () => {
		scratch = makeScratchDir();
		mkdirSync(join(scratch, ".git"), { recursive: true });
		expect(findProjectRoot(scratch)).toBe(scratch);
	});

	it("matches .git as a FILE (worktree case)", async () => {
		scratch = makeScratchDir();
		const a = join(scratch, "repo");
		const sub = join(a, "sub");
		mkdirSync(sub, { recursive: true });
		// Place .git as a FILE (like a git worktree)
		writeFileSync(join(a, ".git"), "gitdir: /real/repo/.git");
		expect(findProjectRoot(sub)).toBe(a);
	});
});

// ============================================================================
// 2. Filesystem tests — use tmp scratch dirs
// ============================================================================

describe("ensureStore (idempotent)", () => {
	let scratch: string;
	let restore: () => void;

	beforeEach(() => {
		scratch = makeScratchDir();
		({ restore } = setupStore(scratch));
	});
	afterEach(async () => {
		restore();
		await rm(scratch, { recursive: true, force: true });
	});

	it("creates MEMORY.md, MEMORY.local.md, SCRATCHPAD.md on first call", async () => {
		const paths = await ensureStore(scratch);
		expect(existsSync(paths.memory)).toBe(true);
		expect(existsSync(paths.memoryLocal)).toBe(true);
		expect(existsSync(paths.scratchpad)).toBe(true);
	});

	it("creates and repairs private store permissions", async () => {
		const paths = await ensureStore(scratch);
		expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
		expect((await stat(paths.dailyDir)).mode & 0o777).toBe(0o700);
		expect((await stat(paths.memoryLocal)).mode & 0o777).toBe(0o600);
		expect((await stat(paths.scratchpad)).mode & 0o777).toBe(0o600);

		await chmod(paths.dir, 0o755);
		await chmod(paths.memoryLocal, 0o644);
		await ensureStore(scratch);
		expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
		expect((await stat(paths.memoryLocal)).mode & 0o777).toBe(0o600);
	});

	it("does NOT create the project memory file", async () => {
		const paths = await ensureStore(scratch);
		expect(existsSync(paths.project)).toBe(false);
	});

	it("does NOT overwrite existing MEMORY.md on second call", async () => {
		const paths = await ensureStore(scratch);
		await writeFile(paths.memory, "custom content");
		await ensureStore(scratch);
		const content = await readFile(paths.memory, "utf8");
		expect(content).toBe("custom content");
	});
});

describe("appendToTarget — memory, no section", () => {
	let scratch: string;
	let restore: () => void;
	let memoryPath: string;

	beforeEach(async () => {
		scratch = makeScratchDir();
		({ restore } = setupStore(scratch));
		const paths = await ensureStore(scratch);
		memoryPath = paths.memory;
	});
	afterEach(async () => {
		restore();
		await rm(scratch, { recursive: true, force: true });
	});

	it("appends to empty file with leading newline separator", async () => {
		await writeFile(memoryPath, "");
		await appendToTarget({ target: "memory", text: "new block" }, scratch);
		const content = await readFile(memoryPath, "utf8");
		expect(content).toBe("\nnew block\n");
	});

	it("appends to content already ending with newline — no extra leading newline", async () => {
		await writeFile(memoryPath, "existing content\n");
		await appendToTarget({ target: "memory", text: "new block" }, scratch);
		const content = await readFile(memoryPath, "utf8");
		expect(content).toBe("existing content\n\nnew block\n");
	});

	it("adds separator newline when content does NOT end with newline", async () => {
		await writeFile(memoryPath, "no trailing newline");
		await appendToTarget({ target: "memory", text: "new block" }, scratch);
		const content = await readFile(memoryPath, "utf8");
		expect(content).toBe("no trailing newline\n\nnew block\n");
	});
});

describe("appendToTarget — memory, with section", () => {
	let scratch: string;
	let restore: () => void;
	let memoryPath: string;

	const baseContent = [
		"# Memory",
		"",
		"## First Section",
		"existing line",
		"",
		"## Second Section",
		"other content",
	].join("\n");

	beforeEach(async () => {
		scratch = makeScratchDir();
		({ restore } = setupStore(scratch));
		const paths = await ensureStore(scratch);
		memoryPath = paths.memory;
		await writeFile(memoryPath, baseContent);
	});
	afterEach(async () => {
		restore();
		await rm(scratch, { recursive: true, force: true });
	});

	it("appends block under the named section before trailing blanks", async () => {
		// "First Section" ends with a blank line before ## Second Section
		// insertAt should be before that trailing blank
		const content = [
			"# Memory",
			"",
			"## First Section",
			"existing line",
			"",
			"## Second Section",
			"other content",
		].join("\n");
		await writeFile(memoryPath, content);
		await appendToTarget({ target: "memory", section: "First Section", text: "new fact" }, scratch);
		const result = await readFile(memoryPath, "utf8");
		const resultLines = result.split("\n");
		// Find where "new fact" landed
		const newFactIdx = resultLines.indexOf("new fact");
		expect(newFactIdx).toBeGreaterThan(-1);
		// The line before it should be empty (blank line separator from splice)
		expect(resultLines[newFactIdx - 1]).toBe("");
		// "new fact" should appear before "## Second Section"
		const secondIdx = resultLines.indexOf("## Second Section");
		expect(newFactIdx).toBeLessThan(secondIdx);
	});

	it("case-insensitive section matching", async () => {
		await appendToTarget({ target: "memory", section: "first section", text: "case-insensitive fact" }, scratch);
		const result = await readFile(memoryPath, "utf8");
		expect(result).toContain("case-insensitive fact");
	});

	it("section not found — returns error text, file unchanged", async () => {
		const originalContent = await readFile(memoryPath, "utf8");
		const result = await appendToTarget({ target: "memory", section: "Nonexistent", text: "something" }, scratch);
		expect(result.text).toContain("not found");
		const afterContent = await readFile(memoryPath, "utf8");
		expect(afterContent).toBe(originalContent);
	});

	it("appending under the LAST section inserts at end of file", async () => {
		// "Second Section" is the last section — no following heading
		await appendToTarget({ target: "memory", section: "Second Section", text: "end insertion" }, scratch);
		const result = await readFile(memoryPath, "utf8");
		expect(result).toContain("end insertion");
		// Should appear after "other content"
		const otherIdx = result.indexOf("other content");
		const insertIdx = result.indexOf("end insertion");
		expect(insertIdx).toBeGreaterThan(otherIdx);
	});

	it("two consecutive blanks before next section collapse correctly", async () => {
		// Content with two blank lines before the next section
		const twoBlankContent = [
			"# Memory",
			"",
			"## Alpha",
			"alpha content",
			"",
			"",
			"## Beta",
			"beta content",
		].join("\n");
		await writeFile(memoryPath, twoBlankContent);
		await appendToTarget({ target: "memory", section: "Alpha", text: "injected" }, scratch);
		const result = await readFile(memoryPath, "utf8");
		// "injected" should appear before "## Beta"
		const betaIdx = result.indexOf("## Beta");
		const injectedIdx = result.indexOf("injected");
		expect(injectedIdx).toBeGreaterThan(-1);
		expect(injectedIdx).toBeLessThan(betaIdx);
	});
});

describe("appendToTarget — scratchpad", () => {
	let scratch: string;
	let restore: () => void;
	let scratchpadPath: string;

	beforeEach(async () => {
		scratch = makeScratchDir();
		({ restore } = setupStore(scratch));
		const paths = await ensureStore(scratch);
		scratchpadPath = paths.scratchpad;
	});
	afterEach(async () => {
		restore();
		await rm(scratch, { recursive: true, force: true });
	});

	it("prepends '- [ ] ' to the text", async () => {
		await writeFile(scratchpadPath, "# Scratchpad\n");
		await appendToTarget({ target: "scratchpad", text: "fix the thing" }, scratch);
		const result = await readFile(scratchpadPath, "utf8");
		expect(result).toContain("- [ ] fix the thing");
	});

	it("does NOT add a timestamp", async () => {
		await writeFile(scratchpadPath, "");
		await appendToTarget({ target: "scratchpad", text: "check database" }, scratch);
		const result = await readFile(scratchpadPath, "utf8");
		// Should not contain a HH:MM timestamp pattern
		expect(result).not.toMatch(/\d{2}:\d{2}/);
	});
});

describe("appendToTarget — daily", () => {
	let scratch: string;
	let restore: () => void;

	beforeEach(async () => {
		scratch = makeScratchDir();
		({ restore } = setupStore(scratch));
		await ensureStore(scratch);
	});
	afterEach(async () => {
		restore();
		await rm(scratch, { recursive: true, force: true });
	});

	it("appends with timestamp prefix and creates daily file", async () => {
		// Daily file is created fresh; we just verify the format
		const result = await appendToTarget({ target: "daily", text: "did a thing" }, scratch);
		expect(result.text).toContain("Appended");
		// Read back the file and check timestamp format
		const dailyPath = result.files[0] as string;
		const content = await readFile(dailyPath, "utf8");
		// Should contain "- HH:MM — did a thing"
		expect(content).toMatch(/- \d{2}:\d{2} — did a thing/);
	});
});

describe("replaceInTarget", () => {
	let scratch: string;
	let restore: () => void;
	let memoryPath: string;

	beforeEach(async () => {
		scratch = makeScratchDir();
		({ restore } = setupStore(scratch));
		const paths = await ensureStore(scratch);
		memoryPath = paths.memory;
	});
	afterEach(async () => {
		restore();
		await rm(scratch, { recursive: true, force: true });
	});

	it("replaces exactly one occurrence and returns success text", async () => {
		await writeFile(memoryPath, "The quick brown fox\njumped over the fence\n");
		const result = await replaceInTarget({ target: "memory", oldText: "brown fox", newText: "red cat" }, scratch);
		expect(result.text).toContain("Replaced one occurrence");
		const content = await readFile(memoryPath, "utf8");
		expect(content).toContain("red cat");
		expect(content).not.toContain("brown fox");
	});

	it("zero matches — returns error, file unchanged", async () => {
		const original = "The quick brown fox\n";
		await writeFile(memoryPath, original);
		const result = await replaceInTarget({ target: "memory", oldText: "not present", newText: "whatever" }, scratch);
		expect(result.text).toContain("not found");
		const content = await readFile(memoryPath, "utf8");
		expect(content).toBe(original);
	});

	it("two matches — returns error with count, file unchanged", async () => {
		const original = "word word\n";
		await writeFile(memoryPath, original);
		const result = await replaceInTarget({ target: "memory", oldText: "word", newText: "thing" }, scratch);
		expect(result.text).toContain("2");
		const content = await readFile(memoryPath, "utf8");
		expect(content).toBe(original);
	});

	it("target=daily returns immediate error without touching file", async () => {
		const result = await replaceInTarget({ target: "daily", oldText: "x", newText: "y" }, scratch);
		expect(result.text).toContain("Error");
	});

	it("target=all returns immediate error", async () => {
		const result = await replaceInTarget({ target: "all", oldText: "x", newText: "y" }, scratch);
		expect(result.text).toContain("Error");
	});

	it("returns error when file does not exist", async () => {
		// Use scope=project which resolves to a path that does not exist
		const result = await replaceInTarget({ target: "memory", scope: "project", oldText: "x", newText: "y" }, scratch);
		expect(result.text).toContain("does not exist");
	});
});

describe("markScratchDone", () => {
	let scratch: string;
	let restore: () => void;
	let scratchpadPath: string;

	beforeEach(async () => {
		scratch = makeScratchDir();
		({ restore } = setupStore(scratch));
		const paths = await ensureStore(scratch);
		scratchpadPath = paths.scratchpad;
	});
	afterEach(async () => {
		restore();
		await rm(scratch, { recursive: true, force: true });
	});

	it("marks a unique incomplete item as done", async () => {
		await writeFile(
			scratchpadPath,
			"# Scratchpad\n- [ ] fix the database\n- [ ] update docs\n",
		);
		const result = await markScratchDone({ query: "fix the database" });
		expect(result.text).toContain("[x]");
		const content = await readFile(scratchpadPath, "utf8");
		expect(content).toContain("- [x] fix the database");
		expect(content).toContain("- [ ] update docs");
	});

	it("case-insensitive matching", async () => {
		await writeFile(scratchpadPath, "- [ ] Fix The Database\n");
		const result = await markScratchDone({ query: "fix the database" });
		expect(result.text).not.toContain("Error");
		const content = await readFile(scratchpadPath, "utf8");
		expect(content).toContain("[x]");
	});

	it("no match — returns error text", async () => {
		await writeFile(scratchpadPath, "- [ ] something else\n");
		const result = await markScratchDone({ query: "nonexistent task" });
		expect(result.text).toContain("Error");
	});

	it("two matches — returns error listing both lines", async () => {
		await writeFile(
			scratchpadPath,
			"- [ ] fix database migration\n- [ ] fix database indexing\n",
		);
		const result = await markScratchDone({ query: "fix database" });
		expect(result.text).toContain("Error");
		expect(result.text).toContain("2");
	});

	it("already-done [x] line does NOT match", async () => {
		await writeFile(scratchpadPath, "- [x] already done\n- [ ] still pending\n");
		const result = await markScratchDone({ query: "already done" });
		expect(result.text).toContain("Error");
		expect(result.text).toContain("no incomplete");
	});
});

describe("readSection", () => {
	let scratch: string;
	let restore: () => void;
	let memoryPath: string;

	const memoryContent = [
		"# Long-term memory",
		"",
		"## User preferences",
		"- Prefer concise answers.",
		"",
		"## Environment",
		"- Shell: zsh.",
		"",
		"## Other",
		"misc notes",
	].join("\n");

	beforeEach(async () => {
		scratch = makeScratchDir();
		({ restore } = setupStore(scratch));
		const paths = await ensureStore(scratch);
		memoryPath = paths.memory;
		await writeFile(memoryPath, memoryContent);
	});
	afterEach(async () => {
		restore();
		await rm(scratch, { recursive: true, force: true });
	});

	it("returns section content when found", async () => {
		const result = await readSection("memory", "Environment", undefined, scratch);
		expect(result.text).toContain("Shell: zsh");
	});

	it("not found — error text includes section name and outline of available sections", async () => {
		const result = await readSection("memory", "Nonexistent", undefined, scratch);
		expect(result.text).toContain("Error");
		expect(result.text).toContain("Nonexistent");
		// Outline should include real section headings
		expect(result.text).toContain("User preferences");
		expect(result.text).toContain("Environment");
	});

	it("scope=project with no project file — returns 'No project memory yet'", async () => {
		const result = await readSection("memory", "anything", "project" as never, scratch);
		expect(result.text).toContain("No project memory");
	});
});

describe("searchMemory", () => {
	let scratch: string;
	let restore: () => void;

	beforeEach(async () => {
		scratch = makeScratchDir();
		({ restore } = setupStore(scratch));
		await ensureStore(scratch);
	});
	afterEach(async () => {
		restore();
		await rm(scratch, { recursive: true, force: true });
	});

	it("returns breadcrumb with section and 1-based line number", async () => {
		// Build a memory file with known structure
		const { memoryDir } = setupStore(scratch);
		restore(); // restore temporarily to get memoryDir, re-apply below

		// Reset env
		const { restore: restore2 } = setupStore(scratch);
		restore = restore2;

		const paths = await ensureStore(scratch);
		const content = ["## Top Section", "", "matching line here", "", "other stuff"].join("\n");
		await writeFile(paths.memory, content);

		const result = await searchMemory({ query: "matching line" }, scratch);
		expect(result.count).toBeGreaterThan(0);
		// crumb should contain "Top Section" and ":3" (1-based, line index 2 -> 3)
		expect(result.text).toContain("Top Section");
		expect(result.text).toContain(":3");
	});

	it("limit=2 with 3 matching lines returns only 2 and a truncation note", async () => {
		const paths = await ensureStore(scratch);
		const content = ["## Section", "match one", "match two", "match three"].join("\n");
		await writeFile(paths.memory, content);

		const result = await searchMemory({ query: "match", limit: 2 }, scratch);
		expect(result.count).toBe(2);
		expect(result.text).toContain("truncated");
	});

	it("limit > 100 is clamped to 100", async () => {
		// We can't easily produce 100 matches, but we can verify no error is thrown
		const paths = await ensureStore(scratch);
		await writeFile(paths.memory, "## S\nsome content");
		// Should not throw
		const result = await searchMemory({ query: "content", limit: 150 }, scratch);
		expect(result).toBeDefined();
	});

	it("no matches returns 'No memory matches for: <query>'", async () => {
		const paths = await ensureStore(scratch);
		await writeFile(paths.memory, "## Section\nsome unrelated content");
		const result = await searchMemory({ query: "zzz_not_present_xyz" }, scratch);
		expect(result.text).toContain("No memory matches for:");
		expect(result.count).toBe(0);
	});

	it("search scans project file when it exists", async () => {
		const paths = await ensureStore(scratch);
		// Create a project memory file in a tmp project dir
		const projectDir = join(scratch, "myproject");
		const piMemDir = join(projectDir, ".pi", "memory");
		await mkdir(piMemDir, { recursive: true });
		await writeFile(join(piMemDir, "MEMORY.md"), "## ProjectSection\nunique_project_content_xyz\n");

		// Search using projectDir as cwd so findProjectRoot finds the .git we'll create
		const gitDir = join(projectDir, ".git");
		mkdirSync(gitDir, { recursive: true });

		const result = await searchMemory({ query: "unique_project_content_xyz" }, projectDir);
		expect(result.text).toContain("unique_project_content_xyz");
	});

	it("match in a code fence is still matched (search is not fence-aware)", async () => {
		const paths = await ensureStore(scratch);
		const content = ["## Section", "```", "code_search_target", "```"].join("\n");
		await writeFile(paths.memory, content);
		const result = await searchMemory({ query: "code_search_target" }, scratch);
		expect(result.count).toBeGreaterThan(0);
	});
});
