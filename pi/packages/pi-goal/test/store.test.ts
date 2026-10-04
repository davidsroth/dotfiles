import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	accountGoalUsage,
	claimGoalRecurrence,
	clearGoal,
	createGoal,
	goalFilePath,
	objectiveFullTextFileName,
	readGoal,
	resetGoalRecurrences,
	updateGoal,
} from "../src/goal/store.js";
import type { Goal, GoalStoreRef } from "../src/goal/types.js";
import { validateObjective } from "../src/goal/validation.js";

const tempDirs: string[] = [];

describe("goal store (budget-free)", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("creates a persisted active goal with no budget field", async () => {
		const ref = await tempStore("thread-create");
		const goal = await createGoal(ref, "  Ship the extension  ");

		expect(goal.threadId).toBe("thread-create");
		expect(goal.objective).toBe("Ship the extension");
		expect(goal.status).toBe("active");
		expect(goal).toMatchObject({ recurrences: 2, recurrencesUsed: 0 });
		expect(goal).not.toHaveProperty("tokenBudget");
		expect(await readGoal(ref)).toMatchObject({ id: goal.id, objective: "Ship the extension" });
		expect(goalFilePath(ref)).toContain(join("extensions", "pi-goal", "thread-create.json"));
		expect(goalFilePath(ref)).not.toContain(".pi");

		const snapshots = ref.getEntries();
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({ type: "custom", customType: "pi-goal:state", data: { version: 2 } });
		expect(JSON.stringify(snapshots)).not.toContain("tokenBudget");
	});

	it("persists recurrence allowances, defaults legacy goals to two, and rejects invalid limits", async () => {
		const ref = await tempStore("recurrence-count");
		const original = await createGoal(ref, "Keep going", 1);
		await expect(claimGoalRecurrence(ref, original.id)).resolves.toMatchObject({ recurrencesUsed: 1 });
		await expect(claimGoalRecurrence(ref, original.id)).resolves.toBeNull();
		await expect(claimGoalRecurrence(ref, "other-goal")).resolves.toBeNull();
		await resetGoalRecurrences(ref);
		expect((await readGoal(ref))?.recurrencesUsed).toBe(0);
		await expect(claimGoalRecurrence(ref, original.id)).resolves.toMatchObject({ recurrencesUsed: 1 });

		const legacy = { ...original };
		delete legacy.recurrences;
		delete legacy.recurrencesUsed;
		const migrated = await tempStore("recurrence-legacy");
		await writeLegacy(migrated, { ...legacy, threadId: migrated.threadId });
		await expect(claimGoalRecurrence(migrated, original.id)).resolves.toMatchObject({ recurrencesUsed: 1 });
		await expect(claimGoalRecurrence(migrated, original.id)).resolves.toMatchObject({ recurrencesUsed: 2 });
		await expect(claimGoalRecurrence(migrated, original.id)).resolves.toBeNull();

		for (const recurrences of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			const invalid = await tempStore(`invalid-${recurrences}`);
			await writeLegacy(invalid, { ...original, threadId: invalid.threadId, recurrences });
			await expect(readGoal(invalid)).rejects.toThrow("goal store contains an invalid goal");
		}
	});

	it("lets the user change recurrences without changing goal status or usage", async () => {
		const ref = await tempStore("recurrence-config");
		const goal = await createGoal(ref, "Keep going", 3);
		await claimGoalRecurrence(ref, goal.id);
		const changed = await updateGoal(ref, { recurrences: 0 }, "user");
		expect(changed).toMatchObject({ id: goal.id, status: "active", recurrences: 0, recurrencesUsed: 0 });
		await expect(claimGoalRecurrence(ref, goal.id)).resolves.toBeNull();
		await expect(updateGoal(ref, { recurrences: 5 }, "model")).rejects.toThrow("only the user");
		await expect(updateGoal(ref, { recurrences: -1 }, "user")).rejects.toThrow("non-negative");
		const paused = await updateGoal(ref, { status: "paused" }, "user");
		const resumed = await updateGoal(ref, { status: "active" }, "user");
		expect(paused.status).toBe("paused");
		expect(resumed).toMatchObject({ status: "active", recurrences: 0, recurrencesUsed: 0 });
	});

	it("preserves inert tokenBudget metadata from existing goal files", async () => {
		const ref = await tempStore("token-budget-wire-compat");
		const original = await createGoal(ref, "Persist metadata only");
		const migrated = await tempStore("budget-legacy");
		await writeLegacy(migrated, { ...original, threadId: migrated.threadId, tokenBudget: 4_096 });
		const loaded = await readGoal(migrated);
		const completed = await updateGoal(migrated, { status: "complete" }, "model");
		expect(loaded?.tokenBudget).toBe(4_096);
		expect(completed.tokenBudget).toBe(4_096);
		expect((await readGoal(migrated))?.tokenBudget).toBe(4_096);
		const invalid = await tempStore("budget-invalid");
		await writeLegacy(invalid, { ...original, threadId: invalid.threadId, tokenBudget: -1 });
		await expect(readGoal(invalid)).rejects.toThrow("goal store contains an invalid goal");
	});

	it("spills a byte-identical oversized objective while storing marker-budget-aware text", async () => {
		const ref = await tempStore("thread/oversized objective");
		const objective = "x".repeat(4_200);

		const goal = await createGoal(ref, objective);

		expect([...goal.objective].length).toBeLessThanOrEqual(4_000);
		expect(goal.objective).toContain("[truncated; full objective:");
		expect(goal.fullObjective).toBe(objective);
		expect((await readGoal(ref))?.fullObjective).toBe(objective);
	});

	it("distinguishes oversized objectives with the same displayed prefix", async () => {
		const ref = await tempStore("oversized-replacement");
		const prefix = "x".repeat(4_200);
		const first = await createGoal(ref, `${prefix} first`);
		const second = await updateGoal(ref, { objective: `${prefix} second` }, "user");
		expect(second.objective).toBe(first.objective);
		expect(second.id).not.toBe(first.id);
		expect(second.fullObjective).toBe(`${prefix} second`);
	});

	it("replaces a completed goal while retaining its earlier session snapshot", async () => {
		const ref = await tempStore("thread/complete-create");
		const original = await createGoal(ref, "Original");
		await updateGoal(ref, { status: "complete" });

		const replacement = await createGoal(ref, "Replacement");

		expect(replacement).toMatchObject({
			objective: "Replacement",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
		});
		expect(replacement.id).not.toBe(original.id);
		expect(await readGoal(ref)).toMatchObject({ id: replacement.id, objective: "Replacement" });
		expect(ref.getEntries()[0]?.data).toMatchObject({ goal: { id: original.id, objective: "Original" } });
		expect(ref.getEntries()).toHaveLength(3);
	});

	it.each(["active", "paused"] as const)("rejects createGoal while a goal is %s", async (status) => {
		const ref = await tempStore(`thread-${status}-create`);
		const original = await createGoal(ref, "Original");
		if (status === "paused") await updateGoal(ref, { status }, "user");

		await expect(createGoal(ref, "Replacement")).rejects.toThrow(
			"cannot create a new goal because this thread already has a goal",
		);
		expect(await readGoal(ref)).toMatchObject({ id: original.id, objective: "Original", status });
	});

	it("replaces changed objectives and preserves usage for status updates", async () => {
		const ref = await tempStore();
		const first = await createGoal(ref, "Original");
		await accountGoalUsage(ref, { input: 23, output: 2, cacheRead: 0, cacheWrite: 4, totalTokens: 25 }, 70);

		const paused = await updateGoal(ref, { status: "paused" }, "user");
		expect(paused.id).toBe(first.id);
		expect(paused.tokensUsed).toBe(25);
		expect(paused.timeUsedSeconds).toBe(70);

		const replaced = await updateGoal(ref, { objective: "Replacement" });
		expect(replaced.id).not.toBe(first.id);
		expect(replaced.tokensUsed).toBe(0);
		expect(replaced.timeUsedSeconds).toBe(0);
		expect(replaced.status).toBe("active");
	});

	it("resumes a matching nonterminal goal when the objective is set again", async () => {
		const ref = await tempStore();
		const first = await createGoal(ref, "Same");
		const paused = await updateGoal(ref, { status: "paused" }, "user");

		const resumed = await updateGoal(ref, { objective: "Same" }, "user");

		expect(paused.id).toBe(first.id);
		expect(resumed.id).toBe(first.id);
		expect(resumed.status).toBe("active");
	});

	it.each([
		["active", "active", true],
		["active", "paused", false],
		["active", "blocked", true],
		["active", "complete", true],
		["paused", "active", false],
		["paused", "paused", true],
		["paused", "blocked", false],
		["paused", "complete", false],
		["blocked", "active", false],
		["blocked", "paused", false],
		["blocked", "blocked", true],
		["blocked", "complete", true],
		["complete", "active", false],
		["complete", "paused", false],
		["complete", "blocked", false],
		["complete", "complete", true],
	] as const)("allows model transition %s -> %s: %s", async (from, to, allowed) => {
		const ref = await tempStore(`model-${from}-${to}`);
		await createGoal(ref, "Transition matrix");
		if (from === "paused") await updateGoal(ref, { status: "paused" }, "user");
		if (from === "blocked") await updateGoal(ref, { status: "blocked", reason: "Waiting on a decision" }, "model");
		if (from === "complete") await updateGoal(ref, { status: "complete" }, "model");

		const update = to === "blocked" ? { status: to, reason: "Waiting on a decision" } : { status: to };
		const transition = updateGoal(ref, update, "model");
		if (allowed) {
			await expect(transition).resolves.toMatchObject({ status: to });
			return;
		}
		await expect(transition).rejects.toThrow(`illegal goal transition: ${from} -> ${to}`);
	});

	it("allows user and system active-paused transitions plus blocked resume", async () => {
		const ref = await tempStore("user-transitions");
		await createGoal(ref, "Transition matrix");

		const paused = await updateGoal(ref, { status: "paused" }, "user");
		const resumed = await updateGoal(ref, { status: "active" }, "user");
		const blocked = await updateGoal(ref, { status: "blocked", reason: "Waiting on a decision" }, "model");
		const resumedBlocked = await updateGoal(ref, { status: "active" }, "user");

		expect(paused.status).toBe("paused");
		expect(resumed.status).toBe("active");
		expect(blocked.status).toBe("blocked");
		expect(resumedBlocked.status).toBe("active");
		expect(resumedBlocked).not.toHaveProperty("blockedReason");
		expect(resumedBlocked).not.toHaveProperty("blockedAt");
	});

	it("persists waiting, clears its question on an actual user resume, and excludes idle time", async () => {
		const ref = await tempStore("waiting-state");
		const original = await createGoal(ref, "Get an answer");
		await expect(updateGoal(ref, { status: "waiting_for_user" }, "model")).rejects.toThrow("waiting question");
		const waiting = await updateGoal(ref, { status: "waiting_for_user", waitingQuestion: "Which option?" }, "model");
		expect(waiting).toMatchObject({ id: original.id, status: "waiting_for_user", waitingQuestion: "Which option?" });
		await accountGoalUsage(
			ref,
			{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
			2,
			"activeOrWaiting",
		);
		const held = await readGoal(ref);
		expect(held?.tokensUsed).toBe(15);
		const resumed = await updateGoal(ref, { status: "active" }, "user");
		expect(resumed).not.toHaveProperty("waitingQuestion");
		await expect(updateGoal(ref, { status: "waiting_for_user", waitingQuestion: "  " }, "model")).rejects.toThrow();
	});

	it("maintains blocked fields, clears them outside blocked, and keeps repeated updates idempotent", async () => {
		const ref = await tempStore("blocked-invariants");
		await createGoal(ref, "Wait for a decision");

		const blocked = await updateGoal(ref, { status: "blocked", reason: "Waiting on a decision" }, "model");
		const repeated = await updateGoal(ref, { status: "blocked", reason: "Different reason" }, "model");
		const completed = await updateGoal(ref, { status: "complete" }, "model");

		expect(blocked).toMatchObject({
			status: "blocked",
			blockedReason: "Waiting on a decision",
			blockedAt: expect.any(Number),
		});
		expect(repeated).toMatchObject({
			status: "blocked",
			blockedReason: blocked.blockedReason,
			blockedAt: blocked.blockedAt,
		});
		expect(repeated.updatedAt).toBeGreaterThan(blocked.updatedAt);
		expect(completed.status).toBe("complete");
		expect(completed).not.toHaveProperty("blockedReason");
		expect(completed).not.toHaveProperty("blockedAt");
	});

	it("rejects persisted blocked-goal invariant violations while accepting a v1 goal without blocked fields", async () => {
		const ref = await tempStore("v1-goal");
		const filePath = goalFilePath(ref);
		await mkdir(dirname(filePath), { recursive: true });
		const v1ActiveGoal = {
			id: "v1-goal",
			threadId: ref.threadId,
			objective: "Old persisted goal",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
			lastStartedAt: 1,
		};
		await writeFile(filePath, `${JSON.stringify({ version: 1, goal: v1ActiveGoal })}\n`, "utf8");
		expect(await readGoal(ref)).toMatchObject(v1ActiveGoal);

		// The migrated snapshot is canonical; subsequent edits to the old file are ignored.
		await writeFile(filePath, JSON.stringify({ version: 1, goal: { ...v1ActiveGoal, status: "blocked" } }), "utf8");
		expect((await readGoal(ref))?.status).toBe("active");
		const invalid = await tempStore("invalid-blocked");
		await writeLegacy(invalid, { ...v1ActiveGoal, threadId: invalid.threadId, status: "blocked" });
		await expect(readGoal(invalid)).rejects.toThrow("goal store contains an invalid goal");
	});

	it("counts non-cached input plus output tokens", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");

		const goal = await accountGoalUsage(
			ref,
			{ input: 100, output: 20, cacheRead: 70, cacheWrite: 0, totalTokens: 999 },
			0,
		);

		expect(goal).toMatchObject({ tokensUsed: 120 });
	});

	it("never transitions status from accounting, regardless of token volume", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");

		const goal = await accountGoalUsage(
			ref,
			{ input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10_000_000 },
			4,
		);

		expect(goal?.status).toBe("active");
		expect(goal?.tokensUsed).toBe(10_000_000);
		expect(goal?.timeUsedSeconds).toBe(4);
	});

	it("only accounts active usage unless the completing turn is finalized", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");
		await updateGoal(ref, { status: "paused" }, "user");

		const activeOnly = await accountGoalUsage(
			ref,
			{ input: 25, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 25 },
			3,
			"active",
		);
		expect(activeOnly).toMatchObject({ status: "paused", tokensUsed: 0, timeUsedSeconds: 0 });
	});

	it("finalizes usage of a blocked turn under activeOrBlocked", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");
		await updateGoal(ref, { status: "blocked", reason: "Waiting on a decision" }, "model");

		const finalized = await accountGoalUsage(
			ref,
			{ input: 25, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
			3,
			"activeOrBlocked",
		);
		expect(finalized).toMatchObject({ status: "blocked", tokensUsed: 30, timeUsedSeconds: 3 });
	});

	it("finalizes usage of the completing turn under activeOrComplete", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");
		await updateGoal(ref, { status: "complete" });

		const finalized = await accountGoalUsage(
			ref,
			{ input: 25, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
			3,
			"activeOrComplete",
		);
		expect(finalized).toMatchObject({ status: "complete", tokensUsed: 30, timeUsedSeconds: 3 });
	});

	it("marks a goal complete and stamps completedAt", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Finish me");

		const completed = await updateGoal(ref, { status: "complete" });
		expect(completed.status).toBe("complete");
		expect(typeof completed.completedAt).toBe("number");
		expect(completed.lastStartedAt).toBeUndefined();
	});

	it("clears the store while preserving the versioned file", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Temporary");

		expect(await clearGoal(ref)).toBe(true);
		expect(await readGoal(ref)).toBeNull();
		expect(ref.getEntries().at(-1)?.data).toEqual({ version: 2, goal: null });
	});
	it("follows the selected branch across divergence, clear tombstones, and compaction", async () => {
		const ref = await tempStore("branching");
		const entries: Array<{ type: string; customType?: string; data?: unknown; id: string; parentId: string | null }> =
			[];
		let leaf: string | null = null;
		ref.getEntries = () => [...entries];
		ref.getBranch = () => {
			const path = [];
			let current = leaf;
			while (current !== null) {
				const entry = entries.find((item) => item.id === current);
				if (!entry) throw new Error("missing tree entry");
				path.unshift(entry);
				current = entry.parentId;
			}
			return path;
		};
		ref.appendEntry = (customType, data) => {
			const id = String(entries.length + 1);
			entries.push({ id, parentId: leaf, type: "custom", customType, data });
			leaf = id;
		};
		const first = await createGoal(ref, "Root objective", 1);
		const root = leaf;
		await updateGoal(ref, { status: "waiting_for_user", waitingQuestion: "Choose?" }, "model");
		const waiting = leaf;
		await claimGoalRecurrence(ref, first.id); // waiting cannot claim
		expect((await readGoal(ref))?.status).toBe("waiting_for_user");
		leaf = root;
		await updateGoal(ref, { status: "paused" }, "user");
		const paused = leaf;
		ref.appendEntry("pi-compaction", { summary: "collapsed context" });
		expect((await readGoal(ref))?.status).toBe("paused");
		leaf = waiting;
		expect(await readGoal(ref)).toMatchObject({
			status: "waiting_for_user",
			waitingQuestion: "Choose?",
			recurrences: 1,
		});
		expect(await clearGoal(ref)).toBe(true);
		expect(await readGoal(ref)).toBeNull();
		leaf = paused;
		expect((await readGoal(ref))?.status).toBe("paused");
		leaf = waiting;
		expect(await readGoal(ref)).toMatchObject({ status: "waiting_for_user" });
	});

	it("migrates legacy once, preserving the full-text sidecar and old files for rollback", async () => {
		const ref = await tempStore("legacy-migration");
		const objective = "many words ".repeat(450);
		const source = await tempStore("source");
		const original = await createGoal(source, objective, 4);
		const legacy: Goal = {
			...original,
			threadId: ref.threadId,
			objective: validateObjective(objective, objectiveFullTextFileName(ref)).objective,
		};
		delete legacy.fullObjective;
		await writeLegacy(ref, legacy);
		const sidecar = join(ref.baseDir, `${encodeURIComponent(ref.threadId)}.objective-full.txt`);
		await writeFile(sidecar, objective, "utf8");
		const imported = await readGoal(ref);
		expect(imported).toMatchObject({ objective: legacy.objective, fullObjective: objective, recurrences: 4 });
		expect(ref.getEntries()).toHaveLength(1);
		await readGoal(ref);
		expect(ref.getEntries()).toHaveLength(1);
		expect(await readFile(sidecar, "utf8")).toBe(objective);
		expect(await readFile(goalFilePath(ref), "utf8")).toContain('"version":1');
		await clearGoal(ref);
		expect(await readGoal(ref)).toBeNull();
		expect(ref.getEntries()).toHaveLength(2);
	});

	it("migrates a legacy null marker, and ignores legacy data when any branch already has state", async () => {
		const ref = await tempStore("legacy-null");
		await writeLegacy(ref, null);
		expect(await readGoal(ref)).toBeNull();
		expect(ref.getEntries()[0]?.data).toEqual({ version: 2, goal: null });
		const copy = await tempStore("old-branch");
		await writeLegacy(copy, {
			id: "old",
			threadId: copy.threadId,
			objective: "Old",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		});
		copy.appendEntry("pi-goal:state", { version: 2, goal: null });
		copy.getBranch = () => [];
		expect(await readGoal(copy)).toBeNull();
		expect(copy.getEntries()).toHaveLength(1);
	});

	it("reports the fork's session ID for copied snapshots, and supports in-memory no-session storage", async () => {
		const original = await tempStore("parent");
		const goal = await createGoal(original, "Carry forward");
		const fork = await tempStore("fork");
		fork.sessionFile = undefined;
		fork.getBranch = () => original.getBranch();
		fork.getEntries = () => original.getEntries();
		expect(await readGoal(fork)).toMatchObject({ id: goal.id, threadId: "fork" });
		const anonymous = await tempStore("no-session");
		anonymous.sessionFile = undefined;
		expect(await readGoal(anonymous)).toBeNull();
		await createGoal(anonymous, "Transient goal");
		expect((await readGoal(anonymous))?.objective).toBe("Transient goal");
	});

	it("rejects corrupt or unsupported session snapshots instead of silently falling back", async () => {
		const ref = await tempStore("bad-state");
		ref.appendEntry("pi-goal:state", { version: 99, goal: null });
		await expect(readGoal(ref)).rejects.toThrow("unsupported goal state version");
		ref.appendEntry("pi-goal:state", { version: 2, goal: { status: "blocked" } });
		await expect(readGoal(ref)).rejects.toThrow("goal state contains an invalid goal");
	});
});

async function tempStore(threadId = "thread-test"): Promise<GoalStoreRef> {
	const dir = await mkdtemp(join(tmpdir(), "pi-goal-"));
	tempDirs.push(dir);
	const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
	return {
		baseDir: join(dir, "extensions", "pi-goal"),
		threadId,
		sessionFile: join(dir, "session.json"),
		getBranch: () => [...entries],
		getEntries: () => [...entries],
		appendEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data });
		},
	};
}

async function writeLegacy(ref: GoalStoreRef, goal: unknown): Promise<void> {
	await mkdir(dirname(goalFilePath(ref)), { recursive: true });
	await writeFile(goalFilePath(ref), JSON.stringify({ version: 1, goal }), "utf8");
}
