import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import memoryExtension, { auditMemory, ensureStore, findSectionRange, MemoryParamsSchema, outsideFenceLines, parseHeadings, renderInjection, searchMemory, TOOL_MAX_BYTES, TOOL_MAX_LINES, type MemoryParams } from "../extensions/memory.js";
import { canonicalPath, mutateFile, readOptional } from "../extensions/storage.js";

const run = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function hostRoot(): string {
	if (process.env.PI_MEMORY_TEST_HOST_ROOT) return process.env.PI_MEMORY_TEST_HOST_ROOT;
	let path = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
	while (path !== dirname(path)) {
		const manifest = join(path, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") return path;
		path = dirname(path);
	}
	throw new Error("Set PI_MEMORY_TEST_HOST_ROOT to the installed Pi package to run loader qualification.");
}

let root: string, agent: string, project: string, paths: Awaited<ReturnType<typeof ensureStore>>, oldEnv: string | undefined;
let tool: any, command: any, hooks: Map<string, any>, ctx: any;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-memory-safety-"));
	agent = join(root, "agent"); project = join(root, "project");
	await mkdir(join(project, ".git"), { recursive: true });
	await mkdir(join(project, ".pi"), { recursive: true });
	await writeFile(join(project, ".pi/settings.json"), "{}");
	oldEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	paths = await ensureStore(project);
	hooks = new Map();
	memoryExtension({ on: (name: string, handler: unknown) => hooks.set(name, handler), registerTool: (value: unknown) => { tool = value; }, registerCommand: (_name: string, value: unknown) => { command = value; } } as never);
	ctx = { cwd: project, isProjectTrusted: () => true, hasUI: false, ui: { notify: vi.fn() } };
});
afterEach(async () => {
	if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldEnv;
	await rm(root, { recursive: true, force: true });
});
const call = (params: MemoryParams) => tool.execute("test", params, undefined, undefined, ctx);
const worker = async (mode: string, payload: unknown = {}, dir = agent, env: NodeJS.ProcessEnv = {}) => {
	const result = await run(process.execPath, [join(packageRoot, "tests/host-worker.mjs"), hostRoot(), join(packageRoot, "extensions/memory.ts"), project, mode, JSON.stringify(payload)], { env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", ...env }, maxBuffer: 2 * 1024 * 1024 });
	return JSON.parse(result.stdout);
};
const assertBound = (text: string) => {
	expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TOOL_MAX_BYTES);
	expect(text.split("\n").length).toBeLessThanOrEqual(TOOL_MAX_LINES);
	expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
};

async function seedHistory() {
	await writeFile(paths.memory, "## Current\nneedle global\n");
	await writeFile(paths.memoryLocal, "needle local\n");
	await writeFile(paths.scratchpad, "needle scratch\n");
	await mkdir(paths.projectDir, { recursive: true });
	await writeFile(paths.project, "needle project\n");
	for (const dir of [join(paths.dir, "archive"), join(paths.projectDir, "archive"), join(paths.dir, "backups"), join(paths.dir, "archive/backups")]) await mkdir(dir, { recursive: true });
	await writeFile(join(paths.dailyDir, "2020-01-01.md"), "needle daily\n");
	await writeFile(join(paths.dir, "archive/old.md"), "needle central history\n");
	await writeFile(join(paths.projectDir, "archive/old.md"), "needle project history\n");
	await writeFile(join(paths.dir, "backups/old.md"), "needle forbidden backup\n");
	await writeFile(join(paths.dir, "archive/backups/old.md"), "needle forbidden backup\n");
	await writeFile(join(paths.dir, "archive/old.backup.md"), "needle forbidden backup\n");
	await symlink(join(paths.dir, "backups"), join(paths.dir, "archive/linked"));
	await symlink(join(paths.dir, "backups/old.md"), join(paths.dir, "archive/link.md"));
	await mkdir(join(root, "unrelated/.pi/memory"), { recursive: true });
	await writeFile(join(root, "unrelated/.pi/memory/MEMORY.md"), "needle unrelated\n");
}

describe("active-first search and continuation", () => {
	it("finds canonical global symlinks, excludes history/backups/unrelated projects by default", async () => {
		await seedHistory();
		const target = join(root, "tracked.md");
		await writeFile(target, await readFile(paths.memory)); await rm(paths.memory); await symlink(target, paths.memory);
		const result = await call({ action: "search", query: "needle" });
		expect(result.details.count).toBe(4);
		expect(result.content[0].text).toContain("[active/global]");
		expect(result.content[0].text).not.toMatch(/history|backup|unrelated|daily/);
		const history = await call({ action: "search", query: "needle", history: "all" });
		expect(history.details.count).toBe(7);
		expect(history.content[0].text.indexOf("[history:")).toBeGreaterThan(history.content[0].text.indexOf("[active/machine]"));
		expect(history.content[0].text).not.toMatch(/forbidden|unrelated/);
	});
	it("filters scope/target and retrieves explicit daily and project archives", async () => {
		await seedHistory();
		const projectOnly = await call({ action: "search", query: "needle", scope: "project", history: "all" });
		expect(projectOnly.details.count).toBe(2);
		expect(projectOnly.content[0].text).not.toMatch(/global|central|scratch|daily/);
		expect((await call({ action: "search", query: "needle", target: "daily" })).details.count).toBe(1);
		expect((await call({ action: "search", query: "needle", target: "scratchpad", history: "all" })).details.count).toBe(1);
	});
	it("paginates without lost matches and detects stale/invalid cursors", async () => {
		await writeFile(paths.memory, "needle one\nneedle two\nneedle three\n");
		const params = { action: "search", query: "needle", scope: "global", limit: 1 } as const;
		let cursor: string | undefined;
		const texts = [];
		do { const result = await call({ ...params, cursor }); texts.push(result.content[0].text); cursor = result.details.nextCursor; } while (cursor);
		expect(texts).toHaveLength(3);
		expect(texts[0]).toContain("needle one"); expect(texts[1]).toContain("needle two"); expect(texts[2]).toContain("needle three");
		const first = await call(params);
		const reordered = await call({ cursor: first.details.nextCursor, scope: "global", query: "needle", limit: 1, action: "search" });
		expect(reordered.content[0].text).toContain("needle two");
		await writeFile(paths.memory, "needle changed\n");
		await expect(call({ ...params, cursor: first.details.nextCursor })).rejects.toThrow("stale");
		await expect(call({ ...params, cursor: "garbage" })).rejects.toThrow("cursor");
	});
	it("returns a recoverable scan-budget continuation even with no matches", async () => {
		for (let n = 0; n < 70; n++) await writeFile(join(paths.dailyDir, `${String(n).padStart(3, "0")}.md`), n === 69 ? "late needle" : "nothing");
		const params = { action: "search", target: "daily", query: "needle" } as const;
		const first = await call(params); expect(first.details.nextCursor).toBeTruthy(); expect(first.details.count).toBe(0);
		const second = await call({ ...params, cursor: first.details.nextCursor }); expect(second.details.count).toBe(1);
	});
	it("bounds huge matching lines/headings and gives exact full-source read locations", async () => {
		await writeFile(paths.memory, "## " + "😀".repeat(50_000) + "\n" + ("needle " + "界".repeat(30_000) + "\n").repeat(70));
		const result = await call({ action: "search", scope: "global", query: "needle", limit: 100 });
		assertBound(result.content[0].text);
		expect(result.content[0].text).toContain("line excerpt; use filesystem read");
		expect(result.details.nextCursor).toBeTruthy();
	});
});

describe("safe publication", () => {
	it("preserves literal replacement tokens and rejects overlapping ambiguity", async () => {
		await writeFile(paths.memory, "before OLD after");
		await call({ action: "replace", oldText: "OLD", newText: "$& $$ $` $' $1" });
		expect(await readFile(paths.memory, "utf8")).toBe("before $& $$ $` $' $1 after");
		await writeFile(paths.memory, "aaa");
		await expect(call({ action: "replace", oldText: "aa", newText: "b" })).rejects.toThrow("2 or more");
	});
	it("fails on non-ENOENT read errors, directories, hard links, and dangling symlinks", async () => {
		await rm(paths.memory); await mkdir(paths.memory);
		await expect(call({ action: "append", text: "never" })).rejects.toThrow("Unsafe");
		await rm(paths.memory, { recursive: true }); await symlink(join(root, "absent"), paths.memory);
		await expect(call({ action: "append", text: "never" })).rejects.toThrow("dangling");
		expect(existsSync(join(root, "absent"))).toBe(false);
		await rm(paths.memory); await writeFile(paths.memory, "private"); await chmod(paths.memory, 0o000);
		try { await expect(call({ action: "append", text: "never" })).rejects.toThrow(/EACCES|EPERM/); }
		finally { await chmod(paths.memory, 0o600); }
		expect(await readFile(paths.memory, "utf8")).toBe("private");
		await link(paths.memory, join(root, "hard-link"));
		await expect(call({ action: "append", text: "never" })).rejects.toThrow("hard link");
	});
	it("rejects invalid UTF-8 and oversized files rather than silently rewriting bytes", async () => {
		const invalid = Buffer.from([0x61, 0xff, 0x62]); await writeFile(paths.memory, invalid);
		await expect(call({ action: "append", text: "wrong" })).rejects.toThrow();
		expect(await readFile(paths.memory)).toEqual(invalid);
		await writeFile(paths.memory, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
		await expect(call({ action: "read" })).rejects.toThrow("exceeds");
		await expect(call({ action: "append", text: "wrong" })).rejects.toThrow("exceeds");
		expect((await stat(paths.memory)).size).toBe(8 * 1024 * 1024 + 1);
	});
	it("keeps originals and removes temporary files on failed/aborted transforms", async () => {
		await writeFile(paths.memory, "original");
		await expect(mutateFile(paths.memory, () => { throw new Error("failure"); })).rejects.toThrow("failure");
		const abort = new AbortController();
		await expect(mutateFile(paths.memory, () => { abort.abort(); return "changed"; }, { signal: abort.signal })).rejects.toThrow();
		expect(await readFile(paths.memory, "utf8")).toBe("original");
		expect((await readdir(paths.dir)).filter((name) => /\.tmp$|\.lock$/.test(name))).toEqual([]);
	});
	it("detects a noncooperating edit before publication rather than overwriting it", async () => {
		await writeFile(paths.memory, "original");
		await expect(mutateFile(paths.memory, async () => { await writeFile(paths.memory, "external edit"); return "stale write"; })).rejects.toThrow("outside");
		expect(await readFile(paths.memory, "utf8")).toBe("external edit");
	});
	it("does not steal an occupied lock or remove its owner's metadata", async () => {
		const lock = `${await canonicalPath(paths.memory)}.pi-memory.lock`;
		await mkdir(lock); await writeFile(join(lock, "owner.json"), "owner");
		await expect(mutateFile(paths.memory, () => "wrong", { timeoutMs: 30 })).rejects.toThrow("lock busy");
		expect(await readFile(join(lock, "owner.json"), "utf8")).toBe("owner");
	});
	it("actual separate registered-tool processes serialize symlink alias writes and preserve mode", async () => {
		const canonical = join(root, "canonical.md"); await writeFile(canonical, "# Start\n", { mode: 0o640 });
		const dirs: string[] = [];
		for (let n = 0; n < 4; n++) {
			const dir = join(root, `agent-${n}`); await mkdir(join(dir, "memory"), { recursive: true });
			await symlink(canonical, join(dir, "memory/MEMORY.md")); dirs.push(dir);
		}
		const barrier = join(root, "barrier"); await mkdir(barrier);
		const writers = dirs.map((dir, id) => worker("append", { id, count: 15, barrier }, dir));
		await vi.waitFor(async () => expect((await readdir(barrier)).length).toBe(4), { timeout: 15_000 });
		await writeFile(join(barrier, "go"), "go");
		await Promise.all(writers);
		const text = await readFile(canonical, "utf8");
		for (let n = 0; n < 4; n++) for (let i = 0; i < 15; i++) expect(text.split(`worker-${n}-${i}\n`)).toHaveLength(2);
		for (const dir of dirs) expect((await lstat(join(dir, "memory/MEMORY.md"))).isSymbolicLink()).toBe(true);
		expect((await stat(canonical)).mode & 0o777).toBe(0o640);
		expect(existsSync(`${canonical}.pi-memory.lock`)).toBe(false);
	}, 30_000);
});

describe("Markdown, schema, and registered lifecycle", () => {
	it("handles variable-length fences, closing info, indent and repeated headings", async () => {
		const lines = ["## Real", "````md", "```", "## Fake", "```` trailing", "- [ ] fake", "`````", "~~~text", "## Fake2", "~~~~", "   ## Final ###"];
		expect(parseHeadings(lines).map((h) => h.title)).toEqual(["Real", "Final"]);
		expect(outsideFenceLines(lines)[5]).toBe(false);
		expect(() => findSectionRange(["## Same", "## same ###"], "Same")).toThrow("Ambiguous");
		await writeFile(paths.memory, "## Same\nfirst\n## Same\nsecond");
		await expect(call({ action: "read", section: "Same" })).rejects.toThrow("Ambiguous");
		await expect(call({ action: "append", section: "Same", text: "wrong" })).rejects.toThrow("Ambiguous");
	});
	it("scratch_done ignores fenced examples without completing nested pending tasks", async () => {
		await writeFile(paths.scratchpad, "````\n- [ ] task\n```\n- [ ] task\n````\n- [ ] task\n  - [ ] child pending\n");
		await call({ action: "scratch_done", query: "task" });
		const text = await readFile(paths.scratchpad, "utf8");
		expect(text.match(/\[x\]/g)).toHaveLength(1); expect(text).toContain("  - [ ] child pending");
	});
	it("schema constrains limits; append defaults to memory; invalid combinations throw", async () => {
		expect(Value.Check(MemoryParamsSchema, { action: "search", query: "x", limit: 1.5 })).toBe(false);
		expect(Value.Check(MemoryParamsSchema, { action: "search", query: "x", history: "all", limit: 100 })).toBe(true);
		await call({ action: "append", text: "default append" });
		expect(await readFile(paths.memory, "utf8")).toContain("default append");
		for (const params of [{ action: "append", target: "all", text: "no" }, { action: "read", target: "scratchpad", section: "no" }, { action: "search", query: "x", limit: -1 }, { action: "search", query: "x", target: "daily", history: "none" }, { action: "scratch_done", scope: "project", query: "x" }, { action: "nope" }]) await expect(call(params as MemoryParams)).rejects.toThrow();
	});
	it("read pages reconstruct Unicode exactly, bound huge outlines, and reject changed sources", async () => {
		const raw = ("## " + "😀界".repeat(20) + "\nbody\n").repeat(1800);
		await writeFile(paths.memory, raw);
		let cursor: string | undefined, combined = "", firstCursor = "";
		do {
			const result = await call({ action: "read", cursor }); assertBound(result.content[0].text);
			combined += result.content[0].text.split("\n\n[Output truncated.")[0];
			cursor = result.details.nextCursor; firstCursor ||= cursor ?? "";
		} while (cursor);
		expect(combined).toBe(raw);
		await writeFile(paths.memory, "changed");
		await expect(call({ action: "read", cursor: firstCursor })).rejects.toThrow("stale");
	});
	it("bounds multi-file reads and every injected block including outlines", async () => {
		await mkdir(paths.projectDir, { recursive: true });
		for (const file of [paths.memory, paths.memoryLocal, paths.project, paths.scratchpad]) await writeFile(file, ("## " + "界😀".repeat(200) + "\n").repeat(250));
		const read = await call({ action: "read", target: "all" }); assertBound(read.content[0].text); expect(read.details.nextCursor).toBeTruthy();
		const injected = await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx);
		expect(Buffer.byteLength(injected.systemPrompt)).toBeLessThanOrEqual(36_010);
		expect(injected.systemPrompt.split("\n").length).toBeLessThanOrEqual(2000);
		const block = renderInjection(await readFile(paths.memory, "utf8"), "global", paths.memory);
		expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(12_000); expect(block.truncated).toBe(true);
		expect(block.text).toContain("follow returned cursor");
	});
	it("trust is fail-closed for injection only, reevaluated each turn; hook failures notify", async () => {
		await mkdir(paths.projectDir, { recursive: true }); await writeFile(paths.project, "PROJECT_PRIVATE_MARKER");
		for (const isTrusted of [undefined, () => false]) {
			ctx.isProjectTrusted = isTrusted;
			const result = await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx);
			expect(result.systemPrompt).not.toContain("PROJECT_PRIVATE_MARKER");
		}
		ctx.isProjectTrusted = () => true;
		expect((await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx)).systemPrompt).toContain("PROJECT_PRIVATE_MARKER");
		await rm(paths.project); await mkdir(paths.project);
		await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cannot inject project"), "error");
	});
	it("audit is metadata-only and read-only, including missing stores and history stats", async () => {
		await seedHistory();
		await writeFile(paths.scratchpad, "- ## malformed-secret\n## duplicate-secret\n## duplicate-secret\n- [ ] open-secret\n- [x] done-secret\n```\n- [ ] example-secret\n```\n");
		const before = (await stat(paths.scratchpad)).mtimeMs;
		const audit = await call({ action: "audit" }); const text = audit.content[0].text; assertBound(text);
		expect(text).not.toMatch(/needle|malformed-secret|duplicate-secret|open-secret|done-secret/);
		const data = JSON.parse(text); const scratch = data.active.find((e: any) => e.target === "scratchpad");
		expect(scratch.duplicateHeadingGroups).toBe(1); expect(scratch.malformedHeadingLines).toEqual([1]); expect(scratch.openCheckboxes).toBe(1); expect(scratch.completedCheckboxes).toBe(1);
		expect(data.history.map((entry: any) => entry.files)).toEqual([1, 1, 1]);
		expect((await stat(paths.scratchpad)).mtimeMs).toBe(before);
		await command.handler("audit", ctx); expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('"store"'), "info");
		process.env.PI_CODING_AGENT_DIR = join(root, "nonexistent-agent");
		await auditMemory({ action: "audit" }, join(root, "absent-project"));
		expect(existsSync(process.env.PI_CODING_AGENT_DIR)).toBe(false);
	});
	it("initialization has no assumed facts/tasks and installed host expands agent-dir tilde", async () => {
		expect(await readFile(paths.memory, "utf8")).not.toMatch(/zsh|Neovim|WezTerm|Prefer concise/);
		expect(await readFile(paths.scratchpad, "utf8")).not.toContain("- [ ]");
		const result = await worker("lifecycle", { query: "unlikely" }, "~/agent-tilde", { HOME: root });
		const report = JSON.parse(result.audit.content[0].text);
		expect(report.store).toBe(join(root, "agent-tilde/memory"));
	}, 30_000);
	it("real host resolver cannot auto-authorize memory-only roots; explicit approvals and denial precedence work", async () => {
		await seedHistory();
		const result = await worker("trust", { scenarios: [
			{ default: "ask" }, { default: "never" }, { saved: false },
			{ saved: true }, { optIn: true }, { saved: false, optIn: true },
			{ override: false, optIn: true }, { resourceful: true, default: "always" },
			{ nested: true, resourceful: true, default: "always" },
			{ nested: true, resourceful: true, default: "always", saved: true },
		] });
		expect(result.map((r: any) => r.hostTrusted)).toEqual([true, true, true, true, true, true, false, true, true, true]);
		expect(result.map((r: any) => r.injectedProject)).toEqual([false, false, false, true, true, false, false, true, false, true]);
		expect(result[0].approval.source).toContain("no affirmative");
		expect(result[8].approval.source).toContain("no affirmative");
	}, 30_000);
	it("only confirmed TUI commands change local approval; revocation overrides host trust", async () => {
		await mkdir(paths.projectDir, { recursive: true }); await writeFile(paths.project, "project marker");
		await expect(command.handler("approve-project", ctx)).rejects.toThrow("interactive TUI");
		expect(existsSync(join(paths.dir, "project-approvals.json"))).toBe(false);
		ctx.mode = "tui"; ctx.hasUI = true; ctx.ui.confirm = async () => false;
		await command.handler("approve-project", ctx);
		expect(existsSync(join(paths.dir, "project-approvals.json"))).toBe(false);
		ctx.ui.confirm = async () => true;
		await command.handler("approve-project", ctx);
		expect((await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx)).systemPrompt).toContain("project marker");
		await command.handler("revoke-project", ctx);
		expect((await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx)).systemPrompt).not.toContain("project marker");
		await expect(call({ action: "approve-project" } as any)).rejects.toThrow("Unsupported");
	});
	it("canonical approval covers symlink aliases but not unrelated projects; malformed state fails closed", async () => {
		await rm(join(project, ".pi/settings.json"));
		await mkdir(paths.projectDir, { recursive: true }); await writeFile(paths.project, "canonical project marker");
		const alias = join(root, "project-alias"); await symlink(project, alias);
		ctx.cwd = alias; ctx.mode = "tui"; ctx.hasUI = true; ctx.ui.confirm = async () => true;
		await command.handler("approve-project", ctx);
		const approvals = JSON.parse(await readFile(join(paths.dir, "project-approvals.json"), "utf8"));
		expect(Object.keys(approvals)).toEqual([await canonicalPath(project)]);
		ctx.cwd = project;
		expect((await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx)).systemPrompt).toContain("canonical project marker");
		const unrelated = join(root, "another"); await mkdir(join(unrelated, ".pi/memory"), { recursive: true }); await writeFile(join(unrelated, ".pi/memory/MEMORY.md"), "another project marker");
		ctx.cwd = unrelated;
		expect((await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx)).systemPrompt).not.toContain("another project marker");
		ctx.cwd = project; await writeFile(join(paths.dir, "project-approvals.json"), "malformed");
		expect((await hooks.get("before_agent_start")({ systemPrompt: "base" }, ctx)).systemPrompt).not.toContain("canonical project marker");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cannot inject project"), "error");
	});
	it("loads installed extension graph, invokes lifecycle/tool/command and real core error flags", async () => {
		await seedHistory();
		const loaded = await worker("lifecycle", { query: "needle" });
		expect(loaded.results[0].systemPrompt).not.toContain("needle project");
		expect(loaded.results[1].systemPrompt).toContain("needle project");
		expect(loaded.search.details.count).toBe(4);
		expect(loaded.notifications.some((row: string[]) => row[0]?.includes('"store"'))).toBe(true);
		const results = await worker("errors", { calls: [{ action: "replace", oldText: "absent", newText: "x" }, { action: "append", section: "missing", text: "x" }, { action: "search" }, { action: "search", query: "x", limit: 0 }, { action: "read" }] });
		expect(results).toHaveLength(5);
		expect(results.map((r: any) => r.isError)).toEqual([true, true, true, true, false]);
	}, 30_000);
});
