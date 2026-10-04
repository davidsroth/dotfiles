import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatGoalToolResponse } from "./format.js";
import { createGoal, readGoal, updateGoal, validateRecurrences } from "./store.js";
import type { Goal, GoalAccountingMode, GoalStoreRef } from "./types.js";
import { MODEL_SETTABLE_GOAL_STATUS_VALUES } from "./types.js";
import { updateGoalUi } from "./ui.js";
import { objectiveTruncationNotice, validateObjective } from "./validation.js";

type GoalToolResult = AgentToolResult<Record<string, never>>;

export type GoalToolRegistrationDeps = {
	goalStoreRef(ctx: ExtensionContext): GoalStoreRef;
	beginAgentGoalAccounting(goal: Goal): void;
	markGoalBlockedThisTurn(goal: Goal): void;
	markGoalWaitingThisTurn(goal: Goal): void;
	markGoalCompletedThisTurn(goal: Goal): void;
	accountCurrentAgentTurn(ctx: ExtensionContext, mode: GoalAccountingMode): Promise<Goal | null>;
};

export function registerGoalTools(pi: ExtensionAPI, deps: GoalToolRegistrationDeps): void {
	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nObjectives are displayed at most 4,000 characters; full oversized text is retained in session state. For longer instructions, prefer a file and refer to it.\nReplaces the current goal when it is complete and archives it; fails if an unfinished goal exists. Optional recurrences controls automatic follow-up turns (default 2).",
		parameters: Type.Object(
			{
				objective: Type.String({
					description:
						"Required. The concrete objective to start pursuing. Display limit: 4,000 characters; full text is retained in session state. For longer instructions, prefer a file and refer to it.",
				}),
				recurrences: Type.Optional(
					Type.Integer({
						minimum: 0,
						description:
							"Maximum automatic follow-up turns before waiting for user input. Default: 2; 0 disables automatic follow-ups.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const ref = deps.goalStoreRef(ctx);
			const current = await readGoal(ref);
			if (current !== null && current.status !== "complete") {
				throw new Error(
					"cannot create a new goal because this thread already has an unfinished goal; use update_goal only when the existing goal is complete",
				);
			}
			const validatedObjective = validateObjective(params.objective, "session goal state");
			const goal = await createGoal(
				ref,
				params.objective,
				params.recurrences === undefined ? undefined : validateRecurrences(params.recurrences),
			);
			deps.beginAgentGoalAccounting(goal);
			updateGoalUi(ctx, goal);
			return toolText(
				formatGoalToolResponse(
					goal,
					validatedObjective.truncated ? objectiveTruncationNotice("session goal state") : undefined,
				),
			);
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Update the existing goal.\nSet status to `complete` only when the objective has actually been achieved and no required work remains. Do not mark a goal complete merely because you are stopping work.\nSet status to `blocked` only after the same blocking condition recurs for at least 3 consecutive goal turns. After resuming, begin a fresh blocked audit after resume. Never mark a goal blocked merely because the work is hard, slow, or uncertain.\nA non-empty reason is required when blocking; reason must not be provided when completing.\nYou cannot use this tool to pause or resume a goal; those status changes are controlled by the user or system.\nWhen marking the goal achieved with status `complete`, report the final elapsed time and token usage from the tool result to the user.",
		parameters: Type.Object(
			{
				status: Type.Union(
					MODEL_SETTABLE_GOAL_STATUS_VALUES.map((status) => Type.Literal(status)),
					{
						description: "Required. Set to complete when achieved or blocked with a non-empty reason.",
					},
				),
				reason: Type.Optional(
					Type.String({
						description: "Required and non-empty when status is blocked; rejected when status is complete.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const reason = params.reason?.trim();
			if (params.status === "blocked" && (reason === undefined || reason.length === 0)) {
				throw new Error("reason is required when status is blocked");
			}
			if (params.status === "complete" && params.reason !== undefined) {
				throw new Error("reason must not be provided when status is complete");
			}
			await deps.accountCurrentAgentTurn(ctx, "active");
			const goal = await updateGoal(
				deps.goalStoreRef(ctx),
				params.status === "blocked"
					? { status: "blocked", ...(reason === undefined ? {} : { reason }) }
					: { status: "complete" },
				"model",
			);
			if (goal.status === "blocked") {
				deps.markGoalBlockedThisTurn(goal);
			} else {
				deps.markGoalCompletedThisTurn(goal);
			}
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal));
		},
	});

	pi.registerTool({
		name: "wait_for_goal_input",
		label: "Wait for Goal Input",
		description:
			"Use only when an active goal genuinely needs a user's answer or decision. Provide the exact question, then ask it visibly in your final response. This stops automatic follow-ups without blocking or completing the goal. Do not use when launch_qna already returned an answer in this turn.",
		parameters: Type.Object(
			{
				question: Type.String({
					minLength: 1,
					maxLength: 1_000,
					description: "The exact question or decision awaiting the user.",
				}),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await deps.accountCurrentAgentTurn(ctx, "active");
			const goal = await updateGoal(
				deps.goalStoreRef(ctx),
				{ status: "waiting_for_user", waitingQuestion: params.question },
				"model",
			);
			deps.markGoalWaitingThisTurn(goal);
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal));
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current goal for this thread, including status, token and elapsed-time usage.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const goal = await deps.accountCurrentAgentTurn(ctx, "active");
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal));
		},
	});
}

function toolText(text: string): GoalToolResult {
	return { content: [{ type: "text" as const, text }], details: {} };
}
