export interface ApprovalBatchInspection {
	blocked: boolean;
	gateNames: string[];
	toolNames: string[];
	reason?: string;
}

interface ToolCallPart {
	id: string;
	name: string;
}

function toolCallsFromEntry(raw: unknown): ToolCallPart[] {
	if (!raw || typeof raw !== "object") return [];
	const entry = raw as { type?: unknown; message?: unknown };
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return [];
	const message = entry.message as { role?: unknown; content?: unknown };
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];

	const calls: ToolCallPart[] = [];
	for (const rawPart of message.content) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as Record<string, unknown>;
		if (part.type !== "toolCall" || typeof part.name !== "string") continue;
		const id = typeof part.id === "string"
			? part.id
			: typeof part.toolUseId === "string"
				? part.toolUseId
				: "";
		if (!id) continue;
		calls.push({ id, name: part.name });
	}
	return calls;
}

/**
 * Inspect the synchronized current assistant tool-calling message.
 *
 * Matching by tool-call id is deliberate: it fails open for unrelated older
 * assistant messages instead of accidentally treating them as the current
 * batch. Pi guarantees sessionManager includes the current assistant message
 * before every tool_call handler runs.
 */
export function inspectApprovalBatch(
	branchEntries: readonly unknown[],
	currentToolCallId: string,
	approvalGateName: "submit_plan" | "submit_draft",
): ApprovalBatchInspection {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const calls = toolCallsFromEntry(branchEntries[index]);
		if (!calls.some((call) => call.id === currentToolCallId)) continue;

		const toolNames = calls.map((call) => call.name);
		const gateNames = toolNames.filter((name) => name === approvalGateName);
		if (gateNames.length === 0 || calls.length === 1) {
			return { blocked: false, gateNames, toolNames };
		}

		return {
			blocked: true,
			gateNames,
			toolNames,
			reason:
				`Approval gate ${approvalGateName} must be the only tool call in its assistant response. ` +
				`This entire batch was blocked; retry ${approvalGateName} alone in a new response.`,
		};
	}

	return { blocked: false, gateNames: [], toolNames: [] };
}
