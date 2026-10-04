import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGoalCommand } from "./goal/command-registration.js";
import { registerGoalLifecycle } from "./goal/lifecycle.js";
import { registerGoalTools } from "./goal/tool-registration.js";
import type { GoalStoreRef } from "./goal/types.js";

export default function goalExtension(pi: ExtensionAPI): void {
	const goalStoreRef = (ctx: ExtensionContext): GoalStoreRef => ({
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "pi-goal"),
		threadId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		getBranch: () => ctx.sessionManager.getBranch(),
		getEntries: () => ctx.sessionManager.getEntries(),
		appendEntry: (type, data) => pi.appendEntry(type, data),
	});
	const lifecycle = registerGoalLifecycle(pi, goalStoreRef);
	registerGoalTools(pi, { goalStoreRef, ...lifecycle });
	registerGoalCommand(pi, { goalStoreRef, ...lifecycle });
}
