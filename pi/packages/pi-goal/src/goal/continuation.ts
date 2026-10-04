import type { Goal } from "./types.js";

export const DEFAULT_RECURRENCES = 2;

export function goalRecurrences(goal: Goal): number {
	return goal.recurrences ?? DEFAULT_RECURRENCES;
}

export function goalRecurrencesUsed(goal: Goal): number {
	return goal.recurrencesUsed ?? 0;
}

function hasRecurrencesRemaining(goal: Goal): boolean {
	return goalRecurrencesUsed(goal) < goalRecurrences(goal);
}

export function shouldQueueGoalContinuationWhenIdle(
	goal: Goal | null,
	isIdle: boolean,
	hasPendingMessages: boolean,
): goal is Goal {
	return goal?.status === "active" && hasRecurrencesRemaining(goal) && isIdle && !hasPendingMessages;
}

export function shouldQueueGoalContinuationAfterAgentEnd(goal: Goal | null, hasPendingMessages: boolean): goal is Goal {
	return goal?.status === "active" && hasRecurrencesRemaining(goal) && !hasPendingMessages;
}
