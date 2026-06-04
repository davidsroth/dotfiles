/**
 * pr-picker.ts — the interactive PR picker overlay component.
 *
 * Mirrors the pi-intercom AgentPickerOverlay pattern: a self-contained
 * `Component` class that owns its own view/selection/scroll state and renders
 * the overlay. The orchestrator (index.ts) owns the PR *data* (prLists) and the
 * refresh lifecycle; the picker reads that data and triggers refreshes through
 * the injected `deps`. It exposes `requestRender()` / `close()` so the
 * orchestrator can re-render it on background data updates and toggle it shut.
 */

import { spawn } from "node:child_process";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { padRight } from "../_shared/tui";
import { PR_OPENER } from "./config";
import { closePR } from "./data";
import { formatPrSummary, topBorderWithTitle } from "./render";
import { PR_VIEWS, type PrListState, type PrView, type PullRequest } from "./types";

export interface PrPickerDeps {
	/** Per-view PR data owned by the orchestrator. `prLists.open` is the live widget state. */
	prLists: Record<PrView, PrListState>;
	/** Trigger a (possibly forced) background refresh of a view's PRs. */
	refreshPRs: (view?: PrView, force?: boolean) => void;
	/** Surface a transient message to the user. */
	notify: (message: string, type?: "info" | "warning" | "error") => void;
}

export class PrPickerOverlay implements Component {
	private view: PrView = "open";
	private selected = 0;
	private scrollTop = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly deps: PrPickerDeps,
		private readonly done: (result: void) => void,
	) {}

	/** Re-render in response to a background data refresh. */
	requestRender(): void {
		this.tui.requestRender();
	}

	/** Close the overlay (used by the toggle shortcut / re-entry). */
	close(): void {
		this.done(undefined);
	}

	invalidate(): void {}

	private listState(): PrListState {
		return this.deps.prLists[this.view];
	}

	private list(): PullRequest[] {
		return this.listState().prs;
	}

	private setView(next: PrView): void {
		if (this.view === next) return;
		this.view = next;
		this.selected = 0;
		this.scrollTop = 0;
		this.deps.refreshPRs(this.view);
		this.tui.requestRender();
	}

	private moveView(delta: number): void {
		const current = PR_VIEWS.indexOf(this.view);
		const next = PR_VIEWS[Math.max(0, Math.min(PR_VIEWS.length - 1, current + delta))]!;
		this.setView(next);
	}

	private formatViewTabs(): string {
		const { theme } = this;
		return PR_VIEWS.map((candidate) => {
			const label = candidate === this.view ? `[${candidate}]` : ` ${candidate} `;
			return candidate === this.view ? theme.bold(theme.fg("accent", label)) : theme.fg("dim", label);
		}).join(theme.fg("dim", "  "));
	}

	private clampSelection(): void {
		const total = this.list().length;
		if (total === 0) {
			this.selected = 0;
			this.scrollTop = 0;
			return;
		}
		if (this.selected >= total) this.selected = total - 1;
		if (this.selected < 0) this.selected = 0;
	}

	private openSelected(): void {
		const pr = this.list()[this.selected];
		if (!pr?.url) {
			this.deps.notify("No URL for this PR", "warning");
			return;
		}
		try {
			const parts = PR_OPENER.split(/\s+/);
			const cmd = parts[0]!;
			const args = [...parts.slice(1), pr.url];
			const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
			child.on("error", (err) => this.deps.notify(`Failed to open: ${err.message}`, "error"));
			child.unref();
			this.deps.notify(`Opened #${pr.number}`, "info");
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.deps.notify(`Failed to open: ${msg}`, "error");
			return;
		}
		this.done(undefined);
	}

	private async closeSelected(): Promise<void> {
		if (this.view !== "open") {
			this.deps.notify("Only open PRs can be closed", "warning");
			return;
		}
		const pr = this.list()[this.selected];
		if (!pr) return;
		try {
			await closePR(pr);
			const open = this.deps.prLists.open;
			open.prs = open.prs.filter((candidate) => candidate.url !== pr.url || candidate.number !== pr.number);
			this.selected = Math.min(this.selected, Math.max(0, open.prs.length - 1));
			this.deps.notify(`Closed #${pr.number}`, "info");
			this.deps.refreshPRs("closed", true);
			this.tui.requestRender();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.deps.notify(`Failed to close #${pr.number}: ${msg}`, "error");
		}
	}

	render(width: number): string[] {
		const { theme } = this;
		this.clampSelection();
		const prs = this.list();
		const inner = Math.max(20, width - 2);

		const currentState = this.listState();
		const summary = formatPrSummary(theme, currentState, this.view);
		const bodyLines: string[] = [this.formatViewTabs()];

		if (currentState.prsLoading && prs.length === 0) {
			bodyLines.push(theme.fg("muted", "  Loading…"));
		} else if (currentState.prsError && prs.length === 0) {
			bodyLines.push(theme.fg("error", `  Error: ${currentState.prsError}`));
		} else if (prs.length === 0) {
			bodyLines.push(theme.fg("muted", `  No ${this.view} PRs`));
		} else {
			const maxRows = Math.max(3, prs.length);
			if (this.selected < this.scrollTop) this.scrollTop = this.selected;
			if (this.selected >= this.scrollTop + maxRows) this.scrollTop = this.selected - maxRows + 1;
			const windowPrs = prs.slice(this.scrollTop, this.scrollTop + maxRows);
			for (let i = 0; i < windowPrs.length; i++) {
				const pr = windowPrs[i]!;
				const isSel = this.scrollTop + i === this.selected;
				const pointer = isSel ? theme.fg("accent", "▸") : " ";
				const marker = pr.isDraft ? theme.fg("dim", "◐") : theme.fg("accent", "●");
				const num = theme.fg("accent", `#${pr.number}`);
				const repo = pr.repo ? `${theme.fg("muted", pr.repo)} ${theme.fg("dim", "·")} ` : "";
				const title = isSel ? theme.bold(theme.fg("text", pr.title)) : theme.fg("text", pr.title);
				bodyLines.push(`${pointer} ${marker} ${num} ${repo}${title}`);
			}
		}

		const paddedBody = bodyLines.map((line) => padRight(truncateToWidth(line, inner, "…"), inner));

		return [
			topBorderWithTitle(theme, summary, inner),
			...paddedBody.map((line) => theme.fg("borderAccent", "│") + line + theme.fg("borderAccent", "│")),
			theme.fg("borderAccent", `╰${"─".repeat(inner)}╯`),
		].map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.ctrlAlt("p")) ||
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			data === "q"
		) {
			this.done(undefined);
			return;
		}
		if (data === "h") {
			this.moveView(-1);
			return;
		}
		if (data === "l") {
			this.moveView(1);
			return;
		}
		if (data === "x") {
			void this.closeSelected();
			return;
		}
		if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.up) || data === "k") {
			const total = this.list().length;
			if (total > 0) {
				this.selected = (this.selected - 1 + total) % total;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.down) || data === "j") {
			const total = this.list().length;
			if (total > 0) {
				this.selected = (this.selected + 1) % total;
				this.tui.requestRender();
			}
			return;
		}
		if (data === "g") {
			this.selected = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "G") {
			this.selected = Math.max(0, this.list().length - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.list().length === 0) return;
			this.openSelected();
			return;
		}
		if (data === "r") {
			this.deps.refreshPRs(this.view, true);
			return;
		}
	}
}
