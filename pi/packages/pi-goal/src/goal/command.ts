import { validateRecurrences } from "./store.js";
import type { GoalStatus } from "./types.js";

export type ParsedGoalCommand =
	| { kind: "show" }
	| { kind: "clear" }
	| { kind: "setStatus"; status: Extract<GoalStatus, "active" | "paused"> }
	| { kind: "setObjective"; objective: string; recurrences?: number }
	| { kind: "setRecurrences"; recurrences: number };

export function parseGoalCommand(rawArgs: string): ParsedGoalCommand {
	const trimmed = rawArgs.trim();
	if (trimmed === "") return { kind: "show" };
	if (/^--recurrences(?:\s|$)/i.test(trimmed)) {
		const match = /^--recurrences\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(trimmed);
		if (!match?.[2]) throw new Error("Usage: /goal --recurrences N <objective>");
		return { kind: "setObjective", objective: match[2], recurrences: parseRecurrences(match[1] ?? "") };
	}
	if (/^recurrences(?:\s|$)/i.test(trimmed)) {
		const match = /^recurrences\s+(\S+)$/i.exec(trimmed);
		if (!match) throw new Error("Usage: /goal recurrences N");
		return { kind: "setRecurrences", recurrences: parseRecurrences(match[1] ?? "") };
	}

	switch (trimmed.toLowerCase()) {
		case "pause":
			return { kind: "setStatus", status: "paused" };
		case "resume":
			return { kind: "setStatus", status: "active" };
		case "clear":
			return { kind: "clear" };
		default:
			return { kind: "setObjective", objective: trimmed };
	}
}

function parseRecurrences(value: string): number {
	if (!/^\d+$/.test(value)) throw new Error("recurrences must be a non-negative safe integer");
	return validateRecurrences(Number(value));
}
