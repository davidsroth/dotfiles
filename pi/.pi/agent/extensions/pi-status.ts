/**
 * pi-status — per-process heartbeat for the tmux session picker.
 *
 * Writes ${XDG_CACHE_HOME:-~/.cache}/pi-status/<pid>.json on session and
 * agent lifecycle events so session-picker.py can mark repos with a
 * working/idle π without scraping pane text. The file is removed on
 * shutdown/exit; the picker deletes files whose pid is no longer alive.
 *
 * Status semantics: "working" while an agent turn runs, except while the
 * launch_qna tool is awaiting answers — a question card is waiting for
 * input, so it counts as idle (this replaces the old pane-text heuristic
 * for the same case).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const QNA_TOOL = "launch_qna";

export type PiStatus = "working" | "idle";

export function statusDir(env: NodeJS.ProcessEnv = process.env): string {
	const base =
		env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim() !== ""
			? env.XDG_CACHE_HOME
			: path.join(os.homedir(), ".cache");
	return path.join(base, "pi-status");
}

export function computeStatus(agentRunning: boolean, qnaInFlight: number): PiStatus {
	return agentRunning && qnaInFlight <= 0 ? "working" : "idle";
}

export interface HeartbeatOptions {
	dir?: string;
	pid?: number;
	interactive?: boolean;
}

export function setupHeartbeat(pi: ExtensionAPI, opts: HeartbeatOptions = {}): { file: string } {
	const dir = opts.dir ?? statusDir();
	const pid = opts.pid ?? process.pid;
	const interactive = opts.interactive ?? process.stdout.isTTY === true;
	const file = path.join(dir, `${pid}.json`);

	let agentRunning = false;
	let qnaInFlight = 0;
	let cwd = process.cwd();

	const write = () => {
		try {
			fs.mkdirSync(dir, { recursive: true });
			// Write-then-rename so the picker never reads a partial file.
			const tmp = `${file}.tmp`;
			fs.writeFileSync(
				tmp,
				JSON.stringify({
					pid,
					cwd,
					interactive,
					status: computeStatus(agentRunning, qnaInFlight),
					updatedAt: new Date().toISOString(),
				}),
			);
			fs.renameSync(tmp, file);
		} catch {
			/* never break the turn over a status file */
		}
	};
	const remove = () => {
		try {
			fs.unlinkSync(file);
		} catch {
			/* already gone */
		}
	};
	const update = (ctx?: { cwd?: string }) => {
		if (ctx?.cwd) cwd = ctx.cwd;
		write();
	};

	pi.on("session_start", async (_event, ctx) => update(ctx));
	pi.on("agent_start", async (_event, ctx) => {
		agentRunning = true;
		update(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		agentRunning = false;
		qnaInFlight = 0;
		update(ctx);
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		if (event.toolName === QNA_TOOL) {
			qnaInFlight++;
			update(ctx);
		}
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName === QNA_TOOL) {
			qnaInFlight = Math.max(0, qnaInFlight - 1);
			update(ctx);
		}
	});
	pi.on("session_shutdown", async () => remove());
	process.on("exit", remove);

	return { file };
}

export default function (pi: ExtensionAPI) {
	setupHeartbeat(pi);
}
