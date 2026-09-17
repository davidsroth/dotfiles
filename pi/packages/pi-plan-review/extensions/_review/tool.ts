/**
 * Tool-result helper. pi's `AgentToolResult<T>` requires both `content` and
 * `details`; most review outcomes return only text, while successful plan
 * approval also carries immutable digest metadata.
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export function toolText(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

export function toolTextWithDetails<T>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details };
}
