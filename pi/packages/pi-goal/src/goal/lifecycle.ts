import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	goalRecurrences,
	goalRecurrencesUsed,
	shouldQueueGoalContinuationAfterAgentEnd,
	shouldQueueGoalContinuationWhenIdle,
} from "./continuation.js";
import { formatGoalForTool, goalStatusLabel } from "./format.js";
import { buildContinuationPrompt } from "./prompt.js";
import { accountGoalUsage, claimGoalRecurrence, readGoal, resetGoalRecurrences, updateGoal } from "./store.js";
import { TurnUsageTracker } from "./turn-usage.js";
import type { Goal, GoalAccountingMode, GoalStoreRef } from "./types.js";
import { updateGoalUi } from "./ui.js";

const GOAL_CONTINUATION_MESSAGE_TYPE = "pi-goal-continuation";
const RESUME_GOAL_CHOICE = "Resume goal";
const LEAVE_GOAL_PAUSED_CHOICE = "Leave paused";
const STALE_EXTENSION_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";

type AgentGoalAccounting = {
	goalId: string;
	measuredFromMilliseconds: number;
};

export type GoalLifecycle = {
	beginAgentGoalAccounting(goal: Goal): void;
	markGoalBlockedThisTurn(goal: Goal): void;
	markGoalWaitingThisTurn(goal: Goal): void;
	markGoalCompletedThisTurn(goal: Goal): void;
	stopAgentGoalAccounting(goalId: string): void;
	clearAgentGoalAccounting(): void;
	accountCurrentAgentTurn(
		ctx: ExtensionContext,
		mode: GoalAccountingMode,
		agentRunMessages?: unknown[],
	): Promise<Goal | null>;
	queueGoalContinuation(ctx: ExtensionContext, goal: Goal): void;
};

export function registerGoalLifecycle(
	pi: ExtensionAPI,
	goalStoreRef: (ctx: ExtensionContext) => GoalStoreRef,
): GoalLifecycle {
	let agentTurnInProgress = false;
	let agentGoalAccounting: AgentGoalAccounting | null = null;
	let blockedThisTurnGoalId: string | null = null;
	let waitingThisTurnGoalId: string | null = null;
	let completedThisTurnGoalId: string | null = null;
	const pendingUserInputs: Array<{ sessionId: string; text: string }> = [];
	let agentAbortSignal: AbortSignal | undefined;
	const turnUsage = new TurnUsageTracker();

	pi.on("session_start", async (event, ctx) => {
		pendingUserInputs.length = 0;
		turnUsage.reset();
		agentTurnInProgress = false;
		agentAbortSignal = undefined;
		clearAgentGoalAccounting();
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		updateGoalUi(ctx, goal);
		if (await maybePromptResumePausedGoal(ctx, event.reason, goal)) return;
		if (shouldQueueGoalContinuationWhenIdle(goal, ctx.isIdle(), ctx.hasPendingMessages())) {
			await queueAutoGoalContinuation(ctx, goal);
		}
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension" || !event.text.trim()) return;
		pendingUserInputs.push({ sessionId: ctx.sessionManager.getSessionId(), text: event.text });
		if (pendingUserInputs.length > 20) pendingUserInputs.shift();
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "user") return;
		const text =
			typeof event.message.content === "string"
				? event.message.content
				: event.message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		const index = pendingUserInputs.findIndex(
			(candidate) =>
				candidate.sessionId === ctx.sessionManager.getSessionId() &&
				(text === candidate.text || text.startsWith(`${candidate.text}\n\n`)),
		);
		if (index < 0) return;
		pendingUserInputs.splice(index, 1);
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "waiting_for_user") {
			const resumed = await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
			beginAgentGoalAccounting(resumed);
			updateGoalUi(ctx, resumed);
		} else if (goal?.status === "active") {
			await resetGoalRecurrences(goalStoreRef(ctx));
		}
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		if (agentGoalAccounting !== null) await accountCurrentAgentTurn(ctx, "active");
	});

	pi.on("session_before_tree", async (_event, ctx) => {
		if (agentGoalAccounting !== null) await accountCurrentAgentTurn(ctx, "active");
	});

	pi.on("session_tree", async (_event, ctx) => {
		// Pi has already moved the leaf. Pending usage from the old branch must not
		// be charged to the newly selected branch.
		pendingUserInputs.length = 0;
		turnUsage.reset();
		agentTurnInProgress = false;
		agentAbortSignal = undefined;
		clearAgentGoalAccounting();
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "active") beginAgentGoalAccounting(goal);
		updateGoalUi(ctx, goal);
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentAbortSignal = ctx.signal;
		agentTurnInProgress = true;
		turnUsage.reset();
		blockedThisTurnGoalId = null;
		waitingThisTurnGoalId = null;
		completedThisTurnGoalId = null;
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			agentGoalAccounting = null;
		}
	});

	pi.on("message_end", async (event) => {
		turnUsage.noteMessageEnd(event.message);
	});

	pi.on("agent_end", async (event, ctx) => {
		const aborted = agentAbortSignal?.aborted === true;
		const mode: GoalAccountingMode =
			blockedThisTurnGoalId !== null
				? "activeOrBlocked"
				: waitingThisTurnGoalId !== null
					? "activeOrWaiting"
					: completedThisTurnGoalId === null
						? "active"
						: "activeOrComplete";
		let goal = await accountCurrentAgentTurn(ctx, mode, event.messages);
		agentTurnInProgress = false;
		blockedThisTurnGoalId = null;
		waitingThisTurnGoalId = null;
		completedThisTurnGoalId = null;
		agentAbortSignal = undefined;
		if (aborted && goal?.status === "active") {
			goal = await updateGoal(
				goalStoreRef(ctx),
				{ status: "blocked", reason: "user interrupted the turn" },
				"model",
			);
		}
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		updateGoalUiBestEffort(ctx, goal);
		if (goal?.status === "active" && !ctx.hasPendingMessages()) {
			if (shouldQueueGoalContinuationAfterAgentEnd(goal, false)) {
				await queueAutoGoalContinuation(ctx, goal);
			} else if (ctx.mode === "tui") {
				ctx.ui.notify(
					`Goal waiting: ${goalRecurrencesUsed(goal)}/${goalRecurrences(goal)} automatic follow-ups used. Reply to continue.`,
					"info",
				);
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (agentGoalAccounting !== null) await accountCurrentAgentTurn(ctx, "active");
		clearAgentGoalAccounting();
	});

	return {
		beginAgentGoalAccounting,
		markGoalBlockedThisTurn,
		markGoalWaitingThisTurn,
		markGoalCompletedThisTurn,
		stopAgentGoalAccounting,
		clearAgentGoalAccounting,
		accountCurrentAgentTurn,
		queueGoalContinuation,
	};

	async function maybePromptResumePausedGoal(
		ctx: ExtensionContext,
		sessionStartReason: string,
		goal: Goal | null,
	): Promise<boolean> {
		if (!isResumeOfPausedGoal(ctx, sessionStartReason, goal)) return false;
		const choice = await ctx.ui.select(`Resume paused goal?\nGoal: ${goal.objective}`, [
			RESUME_GOAL_CHOICE,
			LEAVE_GOAL_PAUSED_CHOICE,
		]);
		if (choice !== RESUME_GOAL_CHOICE) return true;

		const resumed = await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
		beginAgentGoalAccounting(resumed);
		updateGoalUi(ctx, resumed);
		ctx.ui.notify(`Goal ${goalStatusLabel(resumed.status)}\n${formatGoalForTool(resumed)}`, "info");
		queueGoalContinuation(ctx, resumed);
		return true;
	}

	function beginAgentGoalAccounting(goal: Goal): void {
		if (goal.status !== "active" || agentGoalAccounting?.goalId === goal.id) return;
		turnUsage.discardPending();
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function markGoalBlockedThisTurn(goal: Goal): void {
		if (agentTurnInProgress) blockedThisTurnGoalId = goal.id;
	}

	function markGoalWaitingThisTurn(goal: Goal): void {
		if (!agentTurnInProgress) return;
		waitingThisTurnGoalId = goal.id;
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function markGoalCompletedThisTurn(goal: Goal): void {
		if (!agentTurnInProgress) return;
		completedThisTurnGoalId = goal.id;
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function stopAgentGoalAccounting(goalId: string): void {
		if (agentGoalAccounting?.goalId === goalId) agentGoalAccounting = null;
		if (blockedThisTurnGoalId === goalId) blockedThisTurnGoalId = null;
		if (waitingThisTurnGoalId === goalId) waitingThisTurnGoalId = null;
		if (completedThisTurnGoalId === goalId) completedThisTurnGoalId = null;
	}

	function clearAgentGoalAccounting(): void {
		agentGoalAccounting = null;
		blockedThisTurnGoalId = null;
		waitingThisTurnGoalId = null;
		completedThisTurnGoalId = null;
	}

	async function accountCurrentAgentTurn(
		ctx: ExtensionContext,
		mode: GoalAccountingMode,
		agentRunMessages?: unknown[],
	): Promise<Goal | null> {
		const accounting = agentGoalAccounting;
		const ref = goalStoreRef(ctx);
		if (accounting === null) return readGoal(ref);

		const usage =
			agentRunMessages === undefined ? turnUsage.takePending() : turnUsage.takeRemaining(agentRunMessages);
		const now = Date.now();
		const elapsedSeconds = Math.max(0, Math.round((now - accounting.measuredFromMilliseconds) / 1000));
		const goal = await accountGoalUsage(ref, usage, elapsedSeconds, mode, accounting.goalId);
		if (goal?.id === accounting.goalId) {
			agentGoalAccounting = { goalId: accounting.goalId, measuredFromMilliseconds: now };
		} else {
			clearAgentGoalAccounting();
		}
		return goal;
	}

	function queueGoalContinuation(ctx: ExtensionContext, goal: Goal): void {
		if (goal.status === "active" && ctx.isIdle() && !ctx.hasPendingMessages()) {
			// A deliberate /goal or /goal resume handoff does not spend an automatic recurrence.
			queueHiddenGoalPrompt(pi, buildContinuationPrompt(goal));
		}
	}

	async function queueAutoGoalContinuation(ctx: ExtensionContext, goal: Goal): Promise<void> {
		const claimed = await claimGoalRecurrence(goalStoreRef(ctx), goal.id);
		if (claimed) queueHiddenGoalPrompt(pi, buildContinuationPrompt(claimed));
	}
}

function updateGoalUiBestEffort(ctx: ExtensionContext, goal: Goal | null): void {
	try {
		updateGoalUi(ctx, goal);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX)) return;
		throw error;
	}
}

function isResumeOfPausedGoal(ctx: ExtensionContext, sessionStartReason: string, goal: Goal | null): goal is Goal {
	return (
		sessionStartReason === "resume" &&
		goal?.status === "paused" &&
		ctx.hasUI &&
		ctx.isIdle() &&
		!ctx.hasPendingMessages()
	);
}

function queueHiddenGoalPrompt(pi: ExtensionAPI, content: string): void {
	pi.sendMessage(
		{ customType: GOAL_CONTINUATION_MESSAGE_TYPE, content, display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}
