import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import {
	accountGoalUsage,
	claimGoalRecurrence,
	clearGoal,
	createGoal,
	readGoal,
	updateGoal,
} from "../src/goal/store.js";
import type { GoalStoreRef } from "../src/goal/types.js";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("reconstructs real SDK session branches, reload, compaction and a copied fork", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-goal-sdk-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	const ref = storeRef(manager);
	manager.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
	const first = await createGoal(ref, "Keep the root goal", 3);
	const root = manager.getLeafId();
	if (root === null) throw new Error("expected a root leaf");
	await updateGoal(ref, { status: "paused" }, "user");
	manager.branch(root);
	await claimGoalRecurrence(ref, first.id);
	await accountGoalUsage(ref, { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9 }, 3);
	await updateGoal(ref, { status: "waiting_for_user", waitingQuestion: "Which route?" }, "model");
	manager.appendCompaction("Summary", root, 50);
	expect((await readGoal(ref))?.waitingQuestion).toBe("Which route?");
	const waiting = manager.getLeafId();
	if (waiting === null) throw new Error("expected a waiting leaf");
	manager.branch(root);
	await clearGoal(ref);
	expect(await readGoal(ref)).toBeNull();
	manager.branch(waiting);
	expect(await readGoal(ref)).toMatchObject({ id: first.id, status: "waiting_for_user" });

	// Pi delays writing sessions until the first assistant message. This triggers a
	// real file flush, then verifies reconstruction from the file and fork copy.
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Waiting." }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("expected a session file");
	const reopened = SessionManager.open(sessionFile, dir);
	expect(await readGoal(storeRef(reopened))).toMatchObject({
		id: first.id,
		waitingQuestion: "Which route?",
		recurrences: 3,
		recurrencesUsed: 1,
		tokensUsed: 9,
		timeUsedSeconds: 3,
	});
	const fork = SessionManager.forkFrom(sessionFile, dir, dir);
	expect(await readGoal(storeRef(fork))).toMatchObject({ id: first.id, threadId: fork.getSessionId() });
	expect(fork.getSessionId()).not.toBe(manager.getSessionId());
});

it("keeps no-file Pi sessions in memory without creating legacy files", async () => {
	const manager = SessionManager.inMemory();
	const ref = storeRef(manager);
	expect(ref.sessionFile).toBeUndefined();
	await createGoal(ref, "Ephemeral work");
	expect((await readGoal(ref))?.objective).toBe("Ephemeral work");
	expect(manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "pi-goal:state")).toBe(
		true,
	);
});

function storeRef(manager: SessionManager): GoalStoreRef {
	return {
		baseDir: join(manager.getSessionDir(), "extensions", "pi-goal"),
		threadId: manager.getSessionId(),
		sessionFile: manager.getSessionFile(),
		getBranch: () => manager.getBranch(),
		getEntries: () => manager.getEntries(),
		appendEntry: (type, data) => {
			manager.appendCustomEntry(type, data);
		},
	};
}
