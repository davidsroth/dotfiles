/**
 * session_name — let the agent read or set the current session's display name.
 *
 * One tool, get-or-set semantics:
 *   - Called with no args                → returns the current session name (or "<unset>")
 *   - Called with `name: "<label>"`      → sets the session name (trimmed)
 *
 * Overwrites are always allowed, mirroring the built-in `/name` command.
 * No proactive nudging — the model decides when (and whether) to name the session.
 *
 * The display name appears in `/resume`, `pi -r`, and the footer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function sessionNameExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_name",
		label: "Session name",
		description: [
			"Read or set the current pi session's display name.",
			"",
			"Omit `name` to read the current name. Provide `name` to set it.",
			"The name appears in the session selector (/resume, pi -r) and footer.",
			"",
			"Use a short, descriptive label (a few words) that captures the task,",
			"e.g. 'Refactor auth module', 'Investigate flaky CI', 'Dotfiles cleanup'.",
			"Setting a name is optional — only do it once the task is reasonably clear.",
			"Overwriting an existing name is allowed when the focus shifts.",
		].join("\n"),
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({
					description:
						"New session name. Omit to read the current name instead of setting one.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const raw = params.name;

			// Read mode: no name provided.
			if (raw === undefined) {
				const current = pi.getSessionName();
				const text = current ? `Current session name: ${current}` : "No session name set.";
				return {
					content: [{ type: "text", text }],
					details: { mode: "read", current: current ?? null },
				};
			}

			// Write mode: validate before persisting.
			const trimmed = raw.trim();
			if (trimmed.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Refusing to set an empty session name. Omit `name` to read the current value, or pass a non-empty string to set one.",
						},
					],
					isError: true,
					details: { mode: "write", error: "empty" },
				};
			}

			const previous = pi.getSessionName();
			pi.setSessionName(trimmed);

			const text = previous
				? `Session renamed: ${previous} → ${trimmed}`
				: `Session named: ${trimmed}`;

			return {
				content: [{ type: "text", text }],
				details: { mode: "write", previous: previous ?? null, current: trimmed },
			};
		},
	});
}
