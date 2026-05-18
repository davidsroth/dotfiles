/**
 * bordered-editor.ts — Wraps the input editor in a rounded box matching
 * the dashboard / subagents widget visual identity.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TUI, EditorTheme, KeybindingsManager, EditorOptions } from "@earendil-works/pi-tui";

function padRight(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return text;
	return text + " ".repeat(width - w);
}

class BorderedEditor extends CustomEditor {
	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, keybindings, options);
	}

	render(width: number): string[] {
		if (width < 4) {
			return super.render(width);
		}
		const innerWidth = width - 2;
		const lines = super.render(innerWidth);
		const border = this.borderColor;
		return lines.map((line) => border("│") + padRight(line, innerWidth) + border("│"));
	}
}

function applyBorderedEditor(ctx: any) {
	ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
		return new BorderedEditor(tui, theme, keybindings);
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		applyBorderedEditor(ctx);
	});

	pi.registerCommand("bordered", {
		description: "Apply bordered editor style",
		handler: async (_args, ctx) => {
			applyBorderedEditor(ctx);
			ctx.ui.notify("Bordered editor applied", "info");
		},
	});
}
