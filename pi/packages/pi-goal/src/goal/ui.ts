import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { formatGoalElapsedSeconds } from "./format.js";
import type { Goal } from "./types.js";

export const WIDGET_KEY = "goal";

export function updateGoalUi(ctx: ExtensionContext, goal: Goal | null): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	// Clear the old footer segment when reloading from an earlier version.
	ctx.ui.setStatus(WIDGET_KEY, undefined);
	if (goal === null) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			render: (width) => (width > 0 ? [renderGoalWidget(goal, theme, width)] : []),
			invalidate() {},
		}),
		{ placement: "aboveEditor" },
	);
}

export function renderGoalWidget(goal: Goal, theme: Theme, width: number): string {
	if (width <= 0) return "";
	const objective = stripTerminalSequences(goal.objective)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const label = (() => {
		switch (goal.status) {
			case "active":
				return `Goal${goal.timeUsedSeconds > 0 ? ` ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}` : ""}`;
			case "waiting_for_user":
				return "Goal waiting";
			case "paused":
				return "Goal paused";
			case "blocked":
				return "Goal blocked";
			case "complete":
				return "Goal achieved";
		}
	})();
	const color =
		goal.status === "active"
			? "accent"
			: goal.status === "complete"
				? "success"
				: goal.status === "blocked"
					? "warning"
					: "muted";
	const marker =
		goal.status === "complete"
			? "✓"
			: goal.status === "blocked"
				? "!"
				: goal.status === "paused" || goal.status === "waiting_for_user"
					? "◦"
					: "●";
	return truncateToWidth(
		`${theme.fg(color, `${marker} ${label}`)}${theme.fg("dim", " · ")}${theme.fg("muted", objective)}`,
		width,
	);
}
