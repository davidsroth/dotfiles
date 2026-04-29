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
 *   - tokens/cost:   summed from assistant messages on the active branch
 *   - context %:     ctx.getContextUsage()
 *   - model:         ctx.model
 *
 * Disable temporarily with /default-footer (toggles back to pi's built-in).
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename } from "node:path";

interface DirtyState {
	dirty: boolean;
	ahead: number;
	behind: number;
}

export default function (pi: ExtensionAPI) {
	let dirtyState: DirtyState = { dirty: false, ahead: 0, behind: 0 };
	let lastRefreshCwd = "";
	let refreshInFlight = false;
	let installed = true;

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

			// Re-check dirty whenever the branch changes (commit, checkout, etc.)
			const unsubBranch = footerData.onBranchChange(() => {
				refreshDirty(ctx.cwd, requestRender);
			});

			// Initial dirty check
			refreshDirty(ctx.cwd, requestRender);

			return {
				dispose: () => {
					unsubBranch();
				},
				invalidate() {},
				render(width: number): string[] {
					// --- Token / cost totals from active branch ---
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
							cacheRead += m.usage.cacheRead ?? 0;
							cacheWrite += m.usage.cacheWrite ?? 0;
							cost += m.usage.cost.total;
						}
					}

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
					const modelStr = ctx.model?.id ?? "no-model";

					const right = theme.fg(
						"dim",
						`${ctxStr} · ${tokenStr}${cacheStr}${costStr} · ${modelStr}`,
					);

					// Pad between left and right; truncate left first if needed.
					const lW = visibleWidth(left);
					const rW = visibleWidth(right);
					if (lW + rW + 2 > width) {
						// Drop right-side fluff progressively if cramped
						if (width < 60) return [truncateToWidth(left, width)];
						const truncatedLeft = truncateToWidth(left, Math.max(0, width - rW - 2));
						const padW = Math.max(1, width - visibleWidth(truncatedLeft) - rW);
						return [truncatedLeft + " ".repeat(padW) + right];
					}
					const pad = " ".repeat(width - lW - rW);
					return [left + pad + right];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
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
