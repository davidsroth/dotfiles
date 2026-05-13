import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function clearCommand(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				if (!suggestions) return suggestions;

				const line = lines[cursorLine] ?? "";
				const beforeCursor = line.slice(0, cursorCol);
				if (!beforeCursor.startsWith("/") || beforeCursor.includes(" ")) return suggestions;

				const prefix = beforeCursor.slice(1).toLowerCase();
				if (!prefix.startsWith("cl")) return suggestions;

				const priority = new Map([["clear", 0]]);
				const items = [...suggestions.items].sort((a, b) => {
					const aRank = priority.get(a.value.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
					const bRank = priority.get(b.value.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
					return aRank - bRank;
				});

				return { ...suggestions, items };
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});

	const register = (name: string, description: string) => {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				const nextInput = args.trim();

				if (!ctx.isIdle()) {
					const confirmed = ctx.hasUI
						? await ctx.ui.confirm(
							"Clear context?",
							"This will abort the current response and start a fresh session.",
						)
						: true;

					if (!confirmed) {
						ctx.ui.notify("Clear cancelled", "info");
						return;
					}

					ctx.abort();
					await ctx.waitForIdle();
				}

				const result = await ctx.newSession({
					withSession: async (replacementCtx) => {
						if (nextInput) {
							replacementCtx.ui.setEditorText(nextInput);
							replacementCtx.ui.notify("Context cleared. New session ready.", "info");
						} else {
							replacementCtx.ui.notify("Context cleared.", "info");
						}
					},
				});

				if (result.cancelled) {
					ctx.ui.notify("Clear cancelled", "info");
				}
			},
		});
	};

	register("clear", "Start a new empty session, clearing the current conversation context");
}
