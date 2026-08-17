/**
 * custom-footer
 *
 * Replaces pi's default footer with a single-line layout:
 *
 *   <cwd> <sessionName?>  ⎇ <branch> <dirty>           ctx <pct>% · ↑in ↓out · $cost · <model>
 *
 * Data sources:
 *   - cwd:           ctx.cwd
 *   - sessionName:   pi.getSessionName()
 *   - branch:        footerData.getGitBranch() (pi watches .git/HEAD for changes)
 *   - dirty:         our own `git status --porcelain` (cached, refreshed on
 *                    session_start, turn_end, user_bash, and branch change)
 *   - tokens/cost:   assistant usage plus persisted/live subagent cost on the active branch
 *   - context %:     ctx.getContextUsage()
 *   - model:         ctx.model
 *
 * Disable temporarily with /default-footer (toggles back to pi's built-in).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";

interface DirtyState {
	dirty: boolean;
	ahead: number;
	behind: number;
}

export interface BranchUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonNegativeFinite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

/** Router-style ids (e.g. "accounts/fireworks/routers/kimi-k3-fast") are too long
 * for narrow terminals; show the last path segment. */
export function shortModelId(modelId: string): string {
	return modelId.split("/").pop() ?? modelId;
}

/** Compose the single footer line, guaranteeing visibleWidth(result) <= width.
 * pi-tui throws on any overwidth rendered line (see pi-crash.log), so both
 * halves must be clamped — the right side can exceed the terminal on its own. */
export function composeFooterLine(left: string, right: string, width: number): string {
	const lW = visibleWidth(left);
	const rW = visibleWidth(right);
	if (lW + rW + 2 > width) {
		// Drop right-side fluff progressively if cramped
		if (width < 60) return truncateToWidth(left, width);
		const truncatedLeft = truncateToWidth(left, Math.max(0, width - rW - 2));
		const rightBudget = Math.max(0, width - visibleWidth(truncatedLeft) - 1);
		const fittedRight = truncateToWidth(right, rightBudget);
		const padW = Math.max(1, width - visibleWidth(truncatedLeft) - visibleWidth(fittedRight));
		return truncatedLeft + " ".repeat(padW) + fittedRight;
	}
	return left + " ".repeat(width - lW - rW) + right;
}

/** Sum parent usage and the latest cumulative record for each subagent on a branch. */
export function calculateBranchUsage(
	entries: readonly unknown[],
	liveSubagentCosts: ReadonlyMap<string, number> = new Map(),
): BranchUsage {
	const usage: BranchUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	const subagentCosts = new Map<string, number>();

	for (const value of entries) {
		if (!isRecord(value)) continue;

		if (value.type === "message" && isRecord(value.message) && value.message.role === "assistant") {
			const message = value.message as unknown as AssistantMessage;
			usage.input += message.usage.input;
			usage.output += message.usage.output;
			usage.cacheRead += message.usage.cacheRead ?? 0;
			usage.cacheWrite += message.usage.cacheWrite ?? 0;
			usage.cost += message.usage.cost.total;
			continue;
		}

		if (value.type !== "custom" || value.customType !== "subagents:record" || !isRecord(value.data)) {
			continue;
		}
		const id = typeof value.data.id === "string" ? value.data.id : undefined;
		const persistedUsage = isRecord(value.data.usage) ? value.data.usage : undefined;
		const cost = nonNegativeFinite(persistedUsage?.cost ?? value.data.cost);
		if (id && cost !== undefined) subagentCosts.set(id, cost);
	}

	// Live values are cumulative and override a persisted value for the same ID.
	for (const [id, cost] of liveSubagentCosts) {
		if (nonNegativeFinite(cost) !== undefined) subagentCosts.set(id, cost);
	}
	for (const cost of subagentCosts.values()) usage.cost += cost;

	return usage;
}

export default function (pi: ExtensionAPI) {
	let dirtyState: DirtyState = { dirty: false, ahead: 0, behind: 0 };
	let lastRefreshCwd = "";
	let refreshInFlight = false;
	let installed = true;
	let requestFooterRender: (() => void) | undefined;
	const liveSubagentCosts = new Map<string, number>();

	const unsubSubagentUsage = pi.events.on("subagents:usage", (value) => {
		if (!isRecord(value) || typeof value.id !== "string") return;
		const cost = nonNegativeFinite(value.cost);
		if (cost === undefined) return;
		liveSubagentCosts.set(value.id, cost);
		requestFooterRender?.();
	});
	const clearTerminalSubagent = (value: unknown) => {
		if (!isRecord(value) || typeof value.id !== "string") return;
		liveSubagentCosts.delete(value.id);
		requestFooterRender?.();
	};
	const unsubSubagentCompleted = pi.events.on("subagents:completed", clearTerminalSubagent);
	const unsubSubagentFailed = pi.events.on("subagents:failed", clearTerminalSubagent);

	async function refreshDirty(cwd: string, requestRender?: () => void) {
		if (refreshInFlight) return;
		refreshInFlight = true;
		try {
			const res = await pi.exec(
				"git",
				["-C", cwd, "status", "--porcelain=2", "--branch"],
				{ timeout: 1500 },
			);
			if (res.code !== 0) {
				dirtyState = { dirty: false, ahead: 0, behind: 0 };
			} else {
				let dirty = false;
				let ahead = 0;
				let behind = 0;
				for (const line of res.stdout.split("\n")) {
					if (line.startsWith("# branch.ab ")) {
						const m = line.match(/\+(\d+)\s+-(\d+)/);
						if (m) {
							ahead = parseInt(m[1], 10);
							behind = parseInt(m[2], 10);
						}
					} else if (line && !line.startsWith("#")) {
						dirty = true;
					}
				}
				dirtyState = { dirty, ahead, behind };
			}
			lastRefreshCwd = cwd;
			requestRender?.();
		} catch {
			dirtyState = { dirty: false, ahead: 0, behind: 0 };
		} finally {
			refreshInFlight = false;
		}
	}

	function homeShorten(p: string): string {
		const home = process.env.HOME;
		if (home && p.startsWith(home)) return "~" + p.slice(home.length);
		return p;
	}

	function fmtNum(n: number): string {
		if (n < 1000) return `${n}`;
		if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
		return `${(n / 1_000_000).toFixed(1)}M`;
	}

	function install(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
			const requestRender = () => tui.requestRender();
			requestFooterRender = requestRender;

			// Re-check dirty whenever the branch changes (commit, checkout, etc.)
			const unsubBranch = footerData.onBranchChange(() => {
				refreshDirty(ctx.cwd, requestRender);
			});

			// Initial dirty check
			refreshDirty(ctx.cwd, requestRender);

			return {
				dispose: () => {
					unsubBranch();
					if (requestFooterRender === requestRender) requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					// --- Token / cost totals from active branch ---
					const { input, output, cacheRead, cacheWrite, cost } = calculateBranchUsage(
						ctx.sessionManager.getBranch(),
						liveSubagentCosts,
					);

					const ctxUsage = ctx.getContextUsage();
					const pct =
						ctxUsage && ctxUsage.percent !== null
							? `${ctxUsage.percent.toFixed(0)}%`
							: "—";

					// --- LEFT: cwd, session name, git ---
					const cwdDisplay = theme.fg("accent", basename(ctx.cwd) || homeShorten(ctx.cwd));
					const sessionName = pi.getSessionName();
					const sessionPart = sessionName ? " " + theme.fg("dim", `[${sessionName}]`) : "";

					const branch = footerData.getGitBranch();
					let gitPart = "";
					if (branch) {
						const dirtyMark = dirtyState.dirty
							? theme.fg("error", "●")
							: theme.fg("success", "✓");
						const ab: string[] = [];
						if (dirtyState.ahead > 0) ab.push(theme.fg("dim", `↑${dirtyState.ahead}`));
						if (dirtyState.behind > 0) ab.push(theme.fg("dim", `↓${dirtyState.behind}`));
						const abStr = ab.length ? " " + ab.join(" ") : "";
						gitPart = "  " + theme.fg("dim", `⎇ ${branch}`) + " " + dirtyMark + abStr;
					}

					// Extra extension statuses (other extensions calling setStatus)
					const extras: string[] = [];
					for (const [, text] of footerData.getExtensionStatuses()) {
						if (text) extras.push(text);
					}
					const extrasStr = extras.length ? "  " + extras.join("  ") : "";

					const left = cwdDisplay + sessionPart + gitPart + extrasStr;

					// --- RIGHT: context %, tokens, cost, model ---
					const tokenStr = `↑${fmtNum(input)} ↓${fmtNum(output)}`;
					const cacheStr =
						cacheRead || cacheWrite
							? ` ⊕${fmtNum(cacheRead + cacheWrite)}`
							: "";
					const costStr = cost > 0 ? ` · $${cost.toFixed(cost < 1 ? 4 : 2)}` : "";
					const ctxStr = `ctx ${pct}`;
					const modelStr = shortModelId(ctx.model?.id ?? "no-model");

					const right = theme.fg(
						"dim",
						`${ctxStr} · ${tokenStr}${cacheStr}${costStr} · ${modelStr}`,
					);

					return [composeFooterLine(left, right, width)];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		liveSubagentCosts.clear();
		if (installed) install(ctx);
		await refreshDirty(ctx.cwd);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refreshDirty(ctx.cwd);
	});

	pi.on("user_bash", (_event, ctx) => {
		setTimeout(() => {
			refreshDirty(ctx.cwd).catch(() => {});
		}, 100);
		return undefined;
	});

	pi.on("session_shutdown", () => {
		unsubSubagentUsage();
		unsubSubagentCompleted();
		unsubSubagentFailed();
		requestFooterRender = undefined;
		liveSubagentCosts.clear();
	});

	// Toggle for debugging / comparison
	pi.registerCommand("default-footer", {
		description: "Toggle pi's default footer (off = use custom-footer)",
		handler: async (_args, ctx) => {
			installed = !installed;
			if (installed) {
				install(ctx);
				ctx.ui.notify("Custom footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}
