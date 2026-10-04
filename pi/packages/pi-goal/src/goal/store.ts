import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_RECURRENCES, goalRecurrences, goalRecurrencesUsed } from "./continuation.js";
import {
	GoalAlreadyExistsError,
	GoalNotFoundError,
	InvalidGoalStoreError,
	UnsupportedGoalStoreVersionError,
} from "./errors.js";
import { transitionGoalStatus } from "./transitions.js";
import {
	type Goal,
	type GoalAccountingMode,
	type GoalFile,
	type GoalStateEntry,
	type GoalStatus,
	type GoalStoreRef,
	type GoalUpdate,
	type GoalUpdateSource,
	isRecord,
	type TokenUsageSnapshot,
} from "./types.js";
import { resolveTokenBudget, validateObjective } from "./validation.js";

const STORE_VERSION = 1;

export function goalFilePath(ref: GoalStoreRef): string {
	return join(ref.baseDir, `${encodedThreadId(ref)}.json`);
}

export function objectiveFullTextFileName(ref: GoalStoreRef): string {
	return `${encodedThreadId(ref)}.objective-full.txt`;
}

export function objectiveFullTextFilePath(ref: GoalStoreRef): string {
	return join(ref.baseDir, objectiveFullTextFileName(ref));
}

/** Snapshots are branch-local custom entries, never model context. */
export const GOAL_STATE_TYPE = "pi-goal:state";
const STATE_VERSION = 2;
const SESSION_OBJECTIVE_MARKER = "session goal state";

export async function readGoal(ref: GoalStoreRef): Promise<Goal | null> {
	// Check the entire tree before attempting migration, including sibling branches and tombstones.
	const entries = ref.getEntries();
	if (!entries.some(isStateEntry) && ref.sessionFile !== undefined) await migrateLegacyGoal(ref);
	const branch = ref.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry && isStateEntry(entry)) {
			const goal = parseState(entry.data);
			// A fork copies entries but has a new session identity. Never trust the old thread ID.
			return goal === null ? null : { ...goal, threadId: ref.threadId };
		}
	}
	return null;
}

export async function writeGoal(ref: GoalStoreRef, goal: Goal | null): Promise<void> {
	ref.appendEntry(GOAL_STATE_TYPE, { version: STATE_VERSION, goal });
}

function isStateEntry(entry: GoalStateEntry): boolean {
	return entry.type === "custom" && entry.customType === GOAL_STATE_TYPE;
}

function parseState(data: unknown): Goal | null {
	if (!isRecord(data)) throw new InvalidGoalStoreError("goal state must be an object");
	if (data["version"] !== STATE_VERSION) throw new UnsupportedGoalStoreVersionError("unsupported goal state version");
	if (data["goal"] !== null && !isGoal(data["goal"])) {
		throw new InvalidGoalStoreError("goal state contains an invalid goal");
	}
	return data["goal"];
}

async function migrateLegacyGoal(ref: GoalStoreRef): Promise<void> {
	let raw: string;
	try {
		raw = await readFile(goalFilePath(ref), "utf8");
	} catch (error) {
		if (isMissingFile(error)) return;
		throw error;
	}
	const legacy = parseGoalFile(raw).goal;
	if (legacy !== null && legacy.threadId !== ref.threadId) {
		throw new InvalidGoalStoreError("legacy goal belongs to a different session");
	}
	let goal = legacy;
	if (goal !== null) {
		try {
			const fullObjective = await readFile(objectiveFullTextFilePath(ref), "utf8");
			if (
				goal.objective.includes(`… [truncated; full objective: ${objectiveFullTextFileName(ref)}]`) &&
				fullObjective.trim() &&
				fullObjective.startsWith(goal.objective.split("… [truncated;")[0] ?? "")
			) {
				goal = { ...goal, fullObjective };
			}
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}
	// Recheck before appending in case another read migrated it while awaiting I/O.
	if (!ref.getEntries().some(isStateEntry)) await writeGoal(ref, goal);
}

export async function createGoal(
	ref: GoalStoreRef,
	objective: string,
	recurrences = DEFAULT_RECURRENCES,
): Promise<Goal> {
	const validatedObjective = validateObjective(objective, SESSION_OBJECTIVE_MARKER);
	validateRecurrences(recurrences);
	const current = await readGoal(ref);
	if (current !== null && current.status !== "complete") {
		throw new GoalAlreadyExistsError("cannot create a new goal because this thread already has a goal");
	}
	const now = nowSeconds();
	const goal: Goal = {
		id: randomUUID(),
		threadId: ref.threadId,
		objective: validatedObjective.objective,
		...(validatedObjective.truncated ? { fullObjective: objective.trim() } : {}),
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		recurrences,
		recurrencesUsed: 0,
		createdAt: now,
		updatedAt: now,
		lastStartedAt: now,
	};
	await writeGoal(ref, goal);
	return goal;
}

export async function updateGoal(
	ref: GoalStoreRef,
	update: GoalUpdate,
	source: GoalUpdateSource = "model",
): Promise<Goal> {
	const current = await readGoal(ref);
	if (!current) throw new GoalNotFoundError("cannot update goal: no goal exists");

	const validatedObjective =
		update.objective === undefined ? undefined : validateObjective(update.objective, SESSION_OBJECTIVE_MARKER);
	const objective = validatedObjective?.objective ?? current.objective;
	const tokenBudget = resolveTokenBudget(current.tokenBudget, update.tokenBudget);
	if (update.recurrences !== undefined) {
		if (source !== "user") throw new Error("only the user can change goal recurrences");
		validateRecurrences(update.recurrences);
	}
	const now = nextUpdatedAt(current.updatedAt);
	const hasObjectiveUpdate = update.objective !== undefined;
	const replacesGoal =
		hasObjectiveUpdate &&
		(objective !== current.objective ||
			current.status === "complete" ||
			(validatedObjective?.truncated === true && update.objective?.trim() !== current.fullObjective));
	const requestedStatus = update.status ?? (hasObjectiveUpdate ? "active" : undefined);

	if (replacesGoal) {
		const status = requestedStatus ?? "active";
		if (status === "blocked") throw new Error("objective replacement cannot create a blocked goal");
		const next: Goal = {
			id: randomUUID(),
			threadId: ref.threadId,
			objective,
			...(validatedObjective?.truncated && update.objective !== undefined
				? { fullObjective: update.objective.trim() }
				: {}),
			status,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			recurrences: update.recurrences ?? DEFAULT_RECURRENCES,
			recurrencesUsed: 0,
			createdAt: now,
			updatedAt: now,
			...(tokenBudget === undefined ? {} : { tokenBudget }),
		};
		if (status === "active") next.lastStartedAt = now;
		if (status === "complete") next.completedAt = now;
		await writeGoal(ref, next);
		return next;
	}

	const status = requestedStatus ?? current.status;
	const next = transitionGoalStatus(
		{ ...current, objective },
		status,
		source,
		update.reason,
		now,
		update.waitingQuestion,
	);
	if (hasObjectiveUpdate) {
		if (validatedObjective?.truncated && update.objective !== undefined) next.fullObjective = update.objective.trim();
		else delete next.fullObjective;
	}
	if (update.recurrences !== undefined) next.recurrences = update.recurrences;
	if (source === "user" && (update.status === "active" || hasObjectiveUpdate || update.recurrences !== undefined)) {
		next.recurrencesUsed = 0;
	}
	if (tokenBudget === undefined) {
		delete next.tokenBudget;
	} else {
		next.tokenBudget = tokenBudget;
	}
	await writeGoal(ref, next);
	return next;
}

export async function claimGoalRecurrence(ref: GoalStoreRef, expectedGoalId: string): Promise<Goal | null> {
	const goal = await readGoal(ref);
	if (goal?.id !== expectedGoalId || goal.status !== "active" || goalRecurrencesUsed(goal) >= goalRecurrences(goal)) {
		return null;
	}
	const next = { ...goal, recurrencesUsed: goalRecurrencesUsed(goal) + 1, updatedAt: nextUpdatedAt(goal.updatedAt) };
	await writeGoal(ref, next);
	return next;
}

export async function resetGoalRecurrences(ref: GoalStoreRef): Promise<void> {
	const goal = await readGoal(ref);
	if (goal?.status !== "active" || goalRecurrencesUsed(goal) === 0) return;
	await writeGoal(ref, { ...goal, recurrencesUsed: 0, updatedAt: nextUpdatedAt(goal.updatedAt) });
}

export function validateRecurrences(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("recurrences must be a non-negative safe integer");
	return value;
}

export async function clearGoal(ref: GoalStoreRef): Promise<boolean> {
	const hadGoal = (await readGoal(ref)) !== null;
	await writeGoal(ref, null);
	return hadGoal;
}

export async function accountGoalUsage(
	ref: GoalStoreRef,
	usage: TokenUsageSnapshot,
	elapsedSeconds: number,
	mode: GoalAccountingMode = "active",
	expectedGoalId?: string,
): Promise<Goal | null> {
	const goal = await readGoal(ref);
	if (!goal) return goal;
	if (expectedGoalId !== undefined && goal.id !== expectedGoalId) return goal;
	if (!canAccountGoalUsage(goal, mode)) return goal;

	const now = nextUpdatedAt(goal.updatedAt);
	const next: Goal = {
		...goal,
		tokensUsed: goal.tokensUsed + goalTokenDeltaForUsage(usage),
		timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, Math.trunc(elapsedSeconds)),
		updatedAt: now,
	};
	await writeGoal(ref, next);
	return next;
}

function canAccountGoalUsage(goal: Goal, mode: GoalAccountingMode): boolean {
	switch (mode) {
		case "active":
			return goal.status === "active";
		case "activeOrBlocked":
			return goal.status === "active" || goal.status === "blocked";
		case "activeOrComplete":
			return goal.status === "active" || goal.status === "complete";
		case "activeOrWaiting":
			return goal.status === "active" || goal.status === "waiting_for_user";
	}
}

function goalTokenDeltaForUsage(usage: TokenUsageSnapshot): number {
	return Math.max(0, usage.input) + Math.max(0, usage.output);
}

function parseGoalFile(raw: string): GoalFile {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) throw new InvalidGoalStoreError("goal store must be a JSON object");
	if (parsed["version"] !== STORE_VERSION)
		throw new UnsupportedGoalStoreVersionError("unsupported goal store version");
	const goal = parsed["goal"];
	if (goal !== null && !isGoal(goal)) throw new InvalidGoalStoreError("goal store contains an invalid goal");
	return {
		version: STORE_VERSION,
		goal,
	};
}

function isMissingFile(error: unknown): boolean {
	return isErrorWithCode(error) && error.code === "ENOENT";
}

function isErrorWithCode(error: unknown): error is Error & { code: string } {
	return error instanceof Error && "code" in error && typeof error.code === "string";
}

function isGoal(value: unknown): value is Goal {
	if (!isRecord(value) || !isGoalStatus(value["status"])) return false;
	return (
		typeof value["id"] === "string" &&
		typeof value["threadId"] === "string" &&
		typeof value["objective"] === "string" &&
		(value["fullObjective"] === undefined ||
			(typeof value["fullObjective"] === "string" && value["fullObjective"].trim().length > 0)) &&
		(value["criteria"] === undefined ||
			(Array.isArray(value["criteria"]) &&
				value["criteria"].length <= 20 &&
				value["criteria"].every((item: unknown) => typeof item === "string" && item.trim().length > 0))) &&
		(value["tokenBudget"] === undefined || isNonNegativeSafeInteger(value["tokenBudget"])) &&
		(value["recurrences"] === undefined || isNonNegativeSafeInteger(value["recurrences"])) &&
		(value["recurrencesUsed"] === undefined || isNonNegativeSafeInteger(value["recurrencesUsed"])) &&
		hasValidBlockedFields(value, value["status"]) &&
		isNonNegativeSafeInteger(value["tokensUsed"]) &&
		isNonNegativeSafeInteger(value["timeUsedSeconds"]) &&
		isNonNegativeSafeInteger(value["createdAt"]) &&
		isNonNegativeSafeInteger(value["updatedAt"]) &&
		(value["lastStartedAt"] === undefined || isNonNegativeSafeInteger(value["lastStartedAt"])) &&
		(value["status"] === "waiting_for_user"
			? typeof value["waitingQuestion"] === "string" && value["waitingQuestion"].trim().length > 0
			: value["waitingQuestion"] === undefined) &&
		(value["completedAt"] === undefined || isNonNegativeSafeInteger(value["completedAt"]))
	);
}

function hasValidBlockedFields(value: Record<string, unknown>, status: GoalStatus): boolean {
	if (status === "blocked") {
		return (
			typeof value["blockedReason"] === "string" &&
			value["blockedReason"].trim().length > 0 &&
			isNonNegativeSafeInteger(value["blockedAt"])
		);
	}
	return value["blockedReason"] === undefined && value["blockedAt"] === undefined;
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return (
		value === "active" ||
		value === "waiting_for_user" ||
		value === "paused" ||
		value === "blocked" ||
		value === "complete"
	);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return isSafeInteger(value) && value >= 0;
}

function isSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value);
}

function encodedThreadId(ref: GoalStoreRef): string {
	return encodeURIComponent(ref.threadId);
}

function nextUpdatedAt(previousUpdatedAt: number): number {
	return Math.max(nowSeconds(), previousUpdatedAt + 1);
}

function nowSeconds(): number {
	return Math.trunc(Date.now() / 1000);
}
