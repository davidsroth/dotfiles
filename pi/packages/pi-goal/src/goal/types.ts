export const GOAL_STATUS_VALUES = ["active", "waiting_for_user", "paused", "blocked", "complete"] as const;
export const MODEL_SETTABLE_GOAL_STATUS_VALUES = ["complete", "blocked"] as const;

export type GoalStatus = (typeof GOAL_STATUS_VALUES)[number];
export type ModelSettableGoalStatus = (typeof MODEL_SETTABLE_GOAL_STATUS_VALUES)[number];

export type GoalStateEntry = { type: string; customType?: string; data?: unknown };

export type GoalStoreRef = {
	baseDir: string; // Legacy files only; never written by the session store.
	threadId: string;
	sessionFile: string | undefined;
	getBranch(): GoalStateEntry[];
	getEntries(): GoalStateEntry[];
	appendEntry(customType: string, data: unknown): void;
};

export type GoalAccountingMode = "active" | "activeOrBlocked" | "activeOrComplete" | "activeOrWaiting";
export type GoalUpdateSource = "model" | "user";

export type Goal = {
	id: string;
	threadId: string;
	objective: string;
	/** Full text of a new oversized objective (the display objective is capped). */
	fullObjective?: string;
	/** Optional success criteria, retained in full-state snapshots for future editing. */
	criteria?: string[];
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	/** Maximum automatic follow-up turns in one allowance. Missing in older goals means 2. */
	recurrences?: number;
	/** Follow-up turns queued since the last user input or explicit resume. */
	recurrencesUsed?: number;
	createdAt: number;
	updatedAt: number;
	lastStartedAt?: number;
	blockedReason?: string;
	blockedAt?: number;
	waitingQuestion?: string;
	completedAt?: number;
};

export type GoalFile = {
	version: 1;
	goal: Goal | null;
};

export type TokenUsageSnapshot = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
};

export type GoalUpdate = {
	objective?: string;
	status?: GoalStatus;
	reason?: string;
	waitingQuestion?: string;
	tokenBudget?: number | null;
	recurrences?: number;
};

export type GoalToolSnapshot = {
	threadId: string;
	objective: string;
	status: GoalStatus;
	tokensUsed: number;
	timeUsedSeconds: number;
	recurrences: number;
	recurrencesUsed: number;
	createdAt: number;
	updatedAt: number;
	blockedReason?: string;
	blockedAt?: number;
	waitingQuestion?: string;
};

export type GoalToolResponse = {
	goal: GoalToolSnapshot | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
