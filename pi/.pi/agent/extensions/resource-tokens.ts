/**
 * resource-tokens.ts
 *
 * Adds a "[Resource tokens]" section to pi's startup output showing
 * an estimated context-window cost breakdown:
 *
 *   System prompt   ~  3.2k   (base + appendSystemPrompt)
 *   Tools         (12) 4.8k   each itemized
 *     bash                  420
 *     edit                  380
 *     ...
 *   Context files (2) 1.1k    AGENTS.md / CLAUDE.md chain
 *     ~/.pi/agent/AGENTS.md   620
 *     ~/dotfiles/CLAUDE.md    480
 *   Skills        (3) 8.2k    SKILL.md content embedded in the prompt
 *     workspace-explorer    4.1k
 *     librarian             2.8k
 *     setup-oauth           1.3k
 *   ────────────────────────────
 *   Total            ~ 17.3k
 *
 * Token estimate: Math.ceil(chars / 4) — fast char/4 approximation, no deps.
 * Within ~5-10% of actual tokenizer output for English text.
 *
 * Discovery: scans the same directories pi's resource-loader uses
 * (user-level ~/.pi/agent/, project-level <cwd>/.pi/, and packages declared in
 * settings.json). May miss exotic configurations; in practice covers user +
 * project + package-installed resources.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "resource-tokens";
const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_DIR_NAME = ".pi";

// ----- token approximation -----

function approxTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

// ----- resource discovery -----

interface ResourceItem {
	name: string;
	path: string;
	tokens: number;
}

interface Snapshot {
	systemPromptTokens: number; // total assembled system prompt
	baseTokens: number;         // residual = total - tools - context - skills
	tools: ResourceItem[];
	contextFiles: ResourceItem[];
	skills: ResourceItem[];
	totalTokens: number;
}

function readFileSafe(p: string): string | undefined {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
}

function* walkSkillFiles(dir: string): Generator<string> {
	if (!existsSync(dir)) return;
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const ent of entries) {
		const full = join(dir, ent.name);
		const isDir = ent.isDirectory() || (ent.isSymbolicLink() && safeIsDir(full));
		if (isDir) {
			// SKILL.md in subdirectory (skills/<name>/SKILL.md)
			const skillFile = join(full, "SKILL.md");
			if (existsSync(skillFile)) {
				yield skillFile;
				continue;
			}
			// recurse one level for nested layouts
			yield* walkSkillFiles(full);
		} else if (ent.isFile() && ent.name === "SKILL.md") {
			yield full;
		} else if (ent.isFile() && ent.name.endsWith(".md")) {
			// loose .md skills (less common but pi supports it)
			yield full;
		}
	}
}

function safeIsDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function safeIsFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function readSettingsPackages(): string[] {
	const settingsPath = join(AGENT_DIR, "settings.json");
	const raw = readFileSafe(settingsPath);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as { packages?: string[] };
		return Array.isArray(parsed.packages) ? parsed.packages : [];
	} catch {
		return [];
	}
}

/** Resolve a package spec from settings.json to a directory on disk. */
function resolvePackageDir(spec: string): string | undefined {
	// npm: scheme
	if (spec.startsWith("npm:")) {
		// strip 'npm:' and any '@version' suffix that isn't part of the scoped name
		let name = spec.slice(4);
		// for @scope/name@version, the second @ is the version
		const atIdx = name.indexOf("@", name.startsWith("@") ? 1 : 0);
		if (atIdx > 0) name = name.slice(0, atIdx);
		// Try a few likely locations
		const candidates = [
			join(AGENT_DIR, "node_modules", name),
			// pi's global install: walk up from pi-coding-agent if findable
			...findGlobalNodeModules().map((root) => join(root, name)),
		];
		for (const c of candidates) if (safeIsDir(c)) return c;
		return undefined;
	}
	// relative or absolute path — resolve from AGENT_DIR
	const resolved = resolve(AGENT_DIR, spec);
	if (safeIsDir(resolved)) return resolved;
	return undefined;
}

let _cachedGlobalRoots: string[] | undefined;
function findGlobalNodeModules(): string[] {
	if (_cachedGlobalRoots) return _cachedGlobalRoots;
	const roots: string[] = [];
	// Try to find pi's install directory; sibling packages live there
	try {
		const piPkgPath = require.resolve("@earendil-works/pi-coding-agent/package.json");
		// piPkgPath: .../node_modules/@earendil-works/pi-coding-agent/package.json
		// nodemodules root: .../node_modules/
		let cur = dirname(piPkgPath);
		while (cur && cur !== dirname(cur)) {
			if (cur.endsWith(`${"/"}node_modules`) || cur.endsWith(`\\node_modules`)) {
				roots.push(cur);
				break;
			}
			cur = dirname(cur);
		}
	} catch {
		/* ignore */
	}
	_cachedGlobalRoots = roots;
	return roots;
}

/**
 * Discover skill files matching pi's discovery roots.
 * Returns SKILL.md paths (or loose .md skills).
 */
function discoverSkills(cwd: string): string[] {
	const roots = new Set<string>();

	// user-level
	roots.add(join(AGENT_DIR, "skills"));
	// project-level
	roots.add(join(cwd, CONFIG_DIR_NAME, "skills"));

	// package-installed
	for (const spec of readSettingsPackages()) {
		const dir = resolvePackageDir(spec);
		if (!dir) continue;
		// Common layouts: <pkg>/skills/, <pkg>/.pi/skills/
		const pkgSkills = join(dir, "skills");
		if (safeIsDir(pkgSkills)) roots.add(pkgSkills);
		const pkgConfigSkills = join(dir, CONFIG_DIR_NAME, "skills");
		if (safeIsDir(pkgConfigSkills)) roots.add(pkgConfigSkills);
	}

	const found = new Set<string>();
	for (const root of roots) {
		for (const f of walkSkillFiles(root)) {
			found.add(f);
		}
	}
	return [...found];
}

/**
 * Walk up from cwd looking for AGENTS.md / CLAUDE.md (matching
 * loadProjectContextFiles in resource-loader.ts), plus the user-level ones.
 */
function discoverContextFiles(cwd: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

	const checkDir = (dir: string): string | undefined => {
		for (const name of candidates) {
			const p = join(dir, name);
			if (safeIsFile(p)) return p;
		}
		return undefined;
	};

	// user-level first
	const userCtx = checkDir(AGENT_DIR);
	if (userCtx && !seen.has(userCtx)) {
		found.push(userCtx);
		seen.add(userCtx);
	}

	// walk up from cwd (in root-down order at the end)
	const ancestors: string[] = [];
	let cur = cwd;
	const root = resolve("/");
	while (true) {
		const ctx = checkDir(cur);
		if (ctx && !seen.has(ctx)) {
			ancestors.unshift(ctx);
			seen.add(ctx);
		}
		if (cur === root) break;
		const parent = resolve(cur, "..");
		if (parent === cur) break;
		cur = parent;
	}
	found.push(...ancestors);
	return found;
}

// ----- snapshot assembly -----

function skillNameFromPath(p: string): string {
	// .../skills/<name>/SKILL.md → <name>
	const parts = p.split("/");
	if (parts[parts.length - 1] === "SKILL.md" && parts.length >= 2) {
		return parts[parts.length - 2];
	}
	// loose .md
	return parts[parts.length - 1].replace(/\.md$/i, "");
}

function shortenPath(p: string): string {
	const home = homedir();
	if (p.startsWith(home)) return "~" + p.slice(home.length);
	return p;
}

function snapshot(pi: ExtensionAPI, ctx: ExtensionContext): Snapshot {
	const cwd = ctx.cwd;

	// Skills
	const skillPaths = discoverSkills(cwd);
	const skills: ResourceItem[] = skillPaths
		.map((p) => {
			const text = readFileSafe(p) ?? "";
			return { name: skillNameFromPath(p), path: p, tokens: approxTokens(text) };
		})
		.sort((a, b) => b.tokens - a.tokens);

	// Context files
	const ctxPaths = discoverContextFiles(cwd);
	const contextFiles: ResourceItem[] = ctxPaths
		.map((p) => {
			const text = readFileSafe(p) ?? "";
			return { name: shortenPath(p), path: p, tokens: approxTokens(text) };
		})
		.sort((a, b) => b.tokens - a.tokens);

	// Tools — itemized via active tool descriptions + parameter schemas
	const activeNames = new Set(pi.getActiveTools());
	const allTools = pi.getAllTools();
	const tools: ResourceItem[] = allTools
		.filter((t) => activeNames.has(t.name))
		.map((t) => {
			const descTokens = approxTokens(t.description ?? "");
			let paramTokens = 0;
			try {
				paramTokens = approxTokens(JSON.stringify(t.parameters ?? {}));
			} catch {
				/* ignore non-serializable schemas */
			}
			return { name: t.name, path: t.sourceInfo?.path ?? "", tokens: descTokens + paramTokens };
		})
		.sort((a, b) => b.tokens - a.tokens);

	// Total system prompt — this is the authoritative figure from pi
	const systemPromptTokens = approxTokens(ctx.getSystemPrompt() ?? "");

	const toolsTotal = tools.reduce((s, t) => s + t.tokens, 0);
	const ctxTotal = contextFiles.reduce((s, c) => s + c.tokens, 0);
	const skillsTotal = skills.reduce((s, k) => s + k.tokens, 0);
	const baseTokens = Math.max(0, systemPromptTokens - toolsTotal - ctxTotal - skillsTotal);

	return {
		systemPromptTokens,
		baseTokens,
		tools,
		contextFiles,
		skills,
		totalTokens: systemPromptTokens,
	};
}

// ----- renderer -----

interface RenderDetails {
	snapshot: Snapshot;
	reason: "startup" | "reload" | "new" | "resume" | "fork";
}

function buildText(details: RenderDetails, expanded: boolean, theme: any): string {
	const { snapshot: snap } = details;
	const lines: string[] = [];

	const heading = theme.fg("mdHeading", `[Resource tokens]`);
	const dim = (s: string) => theme.fg("dim", s);
	const muted = (s: string) => theme.fg("muted", s);
	const accent = (s: string) => theme.fg("accent", s);

	const summary = `${heading} ${muted(`~${formatTokens(snap.totalTokens)} total system prompt`)}`;
	lines.push(summary);

	if (!expanded) {
		// Compact one-liner under header
		const parts: string[] = [];
		if (snap.baseTokens) parts.push(`base ${formatTokens(snap.baseTokens)}`);
		if (snap.tools.length) parts.push(`tools ${formatTokens(snap.tools.reduce((s, t) => s + t.tokens, 0))}`);
		if (snap.contextFiles.length) parts.push(`context ${formatTokens(snap.contextFiles.reduce((s, c) => s + c.tokens, 0))}`);
		if (snap.skills.length) parts.push(`skills ${formatTokens(snap.skills.reduce((s, k) => s + k.tokens, 0))}`);
		lines.push(dim(`  ${parts.join("  ·  ")}`));
		return lines.join("\n");
	}

	// Expanded: per-item breakdown
	const fmtRow = (label: string, tokens: number, indent = 2) => {
		const pad = " ".repeat(indent);
		const right = formatTokens(tokens).padStart(6);
		const labelLen = label.length;
		const dotCount = Math.max(2, 40 - indent - labelLen);
		const dots = dim(".".repeat(dotCount));
		return `${pad}${label} ${dots} ${right}`;
	};

	const section = (
		title: string,
		count: number,
		total: number,
		items: ResourceItem[],
	) => {
		const header = `${accent(title)} ${dim(`(${count})`)} ${muted(formatTokens(total))}`;
		lines.push(`  ${header}`);
		for (const item of items) {
			lines.push(fmtRow(item.name, item.tokens, 4));
		}
	};

	if (snap.baseTokens) {
		lines.push(`  ${accent("System prompt")} ${muted(`~${formatTokens(snap.baseTokens)}`)} ${dim("(base + append)")}`);
	}
	if (snap.tools.length) {
		section("Tools", snap.tools.length, snap.tools.reduce((s, t) => s + t.tokens, 0), snap.tools);
	}
	if (snap.contextFiles.length) {
		section(
			"Context files",
			snap.contextFiles.length,
			snap.contextFiles.reduce((s, c) => s + c.tokens, 0),
			snap.contextFiles,
		);
	}
	if (snap.skills.length) {
		section(
			"Skills",
			snap.skills.length,
			snap.skills.reduce((s, k) => s + k.tokens, 0),
			snap.skills,
		);
	}

	lines.push(dim(`  ── token estimate: char-count/4 (rough)`));
	return lines.join("\n");
}

// ----- extension entry -----

export default function resourceTokens(pi: ExtensionAPI) {
	pi.registerMessageRenderer<RenderDetails>(CUSTOM_TYPE, (message, { expanded }, theme) => {
		const details = message.details as RenderDetails | undefined;
		if (!details) return undefined;
		const text = buildText(details, expanded, theme);
		const box = new Box(0, 0, undefined);
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.on("session_start", async (event, ctx) => {
		// Only show once on initial startup; skip reload/new/resume/fork to avoid noisy chat entries.
		if (event.reason !== "startup") return;
		if (!ctx.hasUI) return;

		try {
			const snap = snapshot(pi, ctx);
			pi.sendMessage<RenderDetails>({
				customType: CUSTOM_TYPE,
				content: `Resource tokens: ~${formatTokens(snap.totalTokens)}`,
				display: true,
				details: { snapshot: snap, reason: event.reason },
			});
		} catch (err) {
			console.error(
				`[resource-tokens] snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});
}
