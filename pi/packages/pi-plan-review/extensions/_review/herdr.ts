import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Compatibility event consumed by Herdr's managed Pi integration. */
export const HERDR_BLOCKED_EVENT = "herdr:blocked";
let blockerSequence = 0;

function nextBlockerId(): string {
	blockerSequence += 1;
	return `plan-review:${Date.now()}:${blockerSequence}`;
}

/**
 * Mark only an actual root-session external decision wait as blocked. Reporting
 * is optional: browser review must still work when Herdr is absent or an event
 * listener fails. Child sessions do not project their own waits as a blocker on
 * the parent pane; their parent remains working while they are active.
 */
export async function waitWithHerdrBlocked<T>(
	pi: Pick<ExtensionAPI, "events">,
	label: string,
	wait: () => Promise<T>,
): Promise<T> {
	const id = nextBlockerId();
	try {
		pi.events.emit(HERDR_BLOCKED_EVENT, { id, active: true, label });
	} catch {
		// Herdr is optional.
	}
	try {
		return await wait();
	} finally {
		try {
			pi.events.emit(HERDR_BLOCKED_EVENT, { id, active: false, label });
		} catch {
			// Cleanup reporting must not mask the review result.
		}
	}
}
