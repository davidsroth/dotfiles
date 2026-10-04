import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { Goal } from "../src/goal/types.js";
import { renderGoalWidget, updateGoalUi, WIDGET_KEY } from "../src/goal/ui.js";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

describe("goal widget", () => {
	it("renders a minimal one-line goal for each state", () => {
		expect(renderGoalWidget(testGoal({ status: "active", timeUsedSeconds: 0 }), theme, 100)).toBe(
			"● Goal · Port /goal as a pi extension",
		);
		expect(renderGoalWidget(testGoal({ status: "active", timeUsedSeconds: 65 }), theme, 100)).toBe(
			"● Goal 1m · Port /goal as a pi extension",
		);
		expect(renderGoalWidget(testGoal({ status: "waiting_for_user" }), theme, 100)).toBe(
			"◦ Goal waiting · Port /goal as a pi extension",
		);
		expect(renderGoalWidget(testGoal({ status: "paused" }), theme, 100)).toBe(
			"◦ Goal paused · Port /goal as a pi extension",
		);
		expect(renderGoalWidget(testGoal({ status: "blocked" }), theme, 100)).toBe(
			"! Goal blocked · Port /goal as a pi extension",
		);
		expect(renderGoalWidget(testGoal({ status: "complete" }), theme, 100)).toBe(
			"✓ Goal achieved · Port /goal as a pi extension",
		);
	});

	it("fits narrow terminals and wide Unicode without leaking control sequences or newlines", () => {
		const goal = testGoal({ objective: "Ship \u001b[31m🚀界\u001b[0m\nnow\tplease\u0000" });
		for (const width of [0, 1, 4, 12, 28, 80]) {
			const line = renderGoalWidget(goal, theme, width);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(stripTerminalSequences(line)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
			if (width === 80) expect(stripTerminalSequences(line)).toContain("🚀界 now please");
		}
	});

	it("mounts above the editor, updates state, clears the widget and old footer segment", () => {
		const { ctx, setStatus, setWidget } = makeUiCtx("tui", true);
		updateGoalUi(ctx, testGoal({ status: "active" }));
		updateGoalUi(ctx, testGoal({ status: "paused" }));
		updateGoalUi(ctx, null);

		expect(setStatus).toHaveBeenCalledTimes(3);
		expect(setStatus).toHaveBeenCalledWith(WIDGET_KEY, undefined);
		expect(setWidget).toHaveBeenNthCalledWith(1, WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });
		expect(setWidget).toHaveBeenNthCalledWith(2, WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });
		expect(setWidget).toHaveBeenNthCalledWith(3, WIDGET_KEY, undefined);
		const firstFactory = setWidget.mock.calls[0]?.[1];
		const secondFactory = setWidget.mock.calls[1]?.[1];
		expect(typeof firstFactory).toBe("function");
		expect(firstFactory?.(null, theme).render(50)).toEqual(["● Goal 2m · Port /goal as a pi extension"]);
		expect(secondFactory?.(null, theme).render(50)).toEqual(["◦ Goal paused · Port /goal as a pi extension"]);
		expect(firstFactory?.(null, theme).render(0)).toEqual([]);
	});

	it("does not install a terminal widget in non-TUI modes", () => {
		for (const [mode, hasUI] of [
			["rpc", true],
			["tui", false],
			["print", false],
		] as const) {
			const { ctx, setStatus, setWidget } = makeUiCtx(mode, hasUI);
			updateGoalUi(ctx, testGoal());
			expect(setStatus).not.toHaveBeenCalled();
			expect(setWidget).not.toHaveBeenCalled();
		}
	});

	it("uses semantic theme colors for the status and muted objective", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderGoalWidget(testGoal({ status: "blocked" }), { fg } as unknown as Theme, 80);
		expect(fg).toHaveBeenCalledWith("warning", "! Goal blocked");
		expect(fg).toHaveBeenCalledWith("muted", "Port /goal as a pi extension");
	});
});

function makeUiCtx(mode: "tui" | "rpc" | "print", hasUI: boolean) {
	const setStatus = vi.fn();
	const setWidget = vi.fn(
		(
			_key: string,
			factory?: (_tui: null, theme: Theme) => { render(width: number): string[] },
			_options?: { placement: string },
		) => factory,
	);
	const ctx = { hasUI, mode, ui: { setStatus, setWidget } } as unknown as ExtensionContext;
	return { ctx, setStatus, setWidget };
}

function testGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		threadId: "thread-1",
		objective: "Port /goal as a pi extension",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 120,
		createdAt: 1_777_766_400,
		updatedAt: 1_777_766_400,
		...overrides,
	};
}
