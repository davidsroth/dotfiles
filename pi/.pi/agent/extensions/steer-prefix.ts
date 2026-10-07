import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Prefix steering messages (input submitted while the agent is mid-run) so the
 * model knows the message arrived while it was working, not as a fresh turn.
 *
 * Slash-prefixed input is left alone so skill commands and prompt templates
 * still expand.
 */
const PREFIX = "[sent while you were working]";

export default function steerPrefix(pi: ExtensionAPI) {
	pi.on("input", (event) => {
		if (event.streamingBehavior !== "steer") return { action: "continue" };
		// Only user-typed steering; leave extension-injected steers (intercom, subagents) untouched.
		if (event.source !== "interactive") return { action: "continue" };
		if (event.text.trimStart().startsWith("/")) return { action: "continue" };
		if (event.text.startsWith(PREFIX)) return { action: "continue" };

		return {
			action: "transform",
			text: event.text.trim() ? `${PREFIX} ${event.text}` : PREFIX,
			images: event.images,
		};
	});
}
