/**
 * Tool-result helper. pi's `AgentToolResult<T>` requires both `content` and
 * `details`; these review tools only ever return text, so this builds the
 * canonical shape in one place.
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export function toolText(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}
