/**
 * OS integration helpers (macOS-focused): open a URL in the browser, capture
 * and restore the frontmost app, and write to the clipboard.
 */

import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export async function openBrowser(url: string): Promise<void> {
	const cmd =
		process.platform === "darwin" ? `open "${url}"`
		: process.platform === "win32" ? `start "" "${url}"`
		: `xdg-open "${url}"`;
	try { await execAsync(cmd); } catch { /* user navigates manually */ }
}

export async function getFrontmostAppName(): Promise<string | null> {
	if (process.platform !== "darwin") return null;
	try {
		const { stdout } = await execFileAsync("osascript", [
			"-e",
			'tell application "System Events" to get name of first application process whose frontmost is true',
		]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

export function focusApp(appName: string | null): void {
	if (process.platform !== "darwin" || !appName) return;
	setTimeout(() => {
		void execFileAsync("osascript", ["-e", `tell application ${JSON.stringify(appName)} to activate`]).catch(() => undefined);
	}, 800);
}

export async function pbcopy(text: string): Promise<void> {
	if (process.platform !== "darwin") throw new Error("pbcopy is macOS-only");
	await new Promise<void>((resolve, reject) => {
		const child = spawn("pbcopy");
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`pbcopy exited with code ${code}`));
		});
		child.stdin.write(text);
		child.stdin.end();
	});
}
