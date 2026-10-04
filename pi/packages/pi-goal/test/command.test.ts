import { describe, expect, it } from "vitest";

import { parseGoalCommand } from "../src/goal/command.js";

describe("goal command parsing", () => {
	it("treats bare /goal as a summary request", () => {
		expect(parseGoalCommand("")).toEqual({ kind: "show" });
	});

	it("treats arbitrary text after /goal as the objective", () => {
		expect(parseGoalCommand("ship the Codex style flow --token-budget 88")).toEqual({
			kind: "setObjective",
			objective: "ship the Codex style flow --token-budget 88",
		});
	});

	it("parses recurrence limits on new and existing goals", () => {
		expect(parseGoalCommand("--recurrences 0 ship the release")).toEqual({
			kind: "setObjective",
			objective: "ship the release",
			recurrences: 0,
		});
		expect(parseGoalCommand("recurrences 5")).toEqual({ kind: "setRecurrences", recurrences: 5 });
		expect(parseGoalCommand("RECURRENCES 2")).toEqual({ kind: "setRecurrences", recurrences: 2 });
	});

	it.each([
		"recurrences",
		"recurrences -1",
		"recurrences 1.5",
		"recurrences 9007199254740992",
		"--recurrences 2",
		"--recurrences wat work",
	])("rejects malformed recurrence syntax: %s", (raw) => expect(() => parseGoalCommand(raw)).toThrow());

	it("does not require or special-case a set subcommand", () => {
		expect(parseGoalCommand("set up the release")).toEqual({
			kind: "setObjective",
			objective: "set up the release",
		});
	});

	it("keeps Codex-style control commands reserved", () => {
		expect(parseGoalCommand("pause")).toEqual({ kind: "setStatus", status: "paused" });
		expect(parseGoalCommand("resume")).toEqual({ kind: "setStatus", status: "active" });
		expect(parseGoalCommand("clear")).toEqual({ kind: "clear" });
	});

	it("treats non-Codex control words as objectives", () => {
		expect(parseGoalCommand("status")).toEqual({ kind: "setObjective", objective: "status" });
		expect(parseGoalCommand("complete")).toEqual({ kind: "setObjective", objective: "complete" });
		expect(parseGoalCommand("help")).toEqual({ kind: "setObjective", objective: "help" });
	});
});
