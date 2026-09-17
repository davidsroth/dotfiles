import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function sessionJsonl(options: { id?: string; cwd?: string; timestamp?: string; entries?: unknown[] } = {}): string {
	const header = {
		type: "session",
		version: 3,
		id: options.id ?? "session-1",
		timestamp: options.timestamp ?? "2026-08-10T12:00:00.000Z",
		cwd: options.cwd ?? "/work/project",
	};
	return [header, ...(options.entries ?? [])].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

export function message(
	id: string,
	parentId: string | null,
	role: "user" | "assistant" | "toolResult",
	content: unknown[],
	timestamp = "2026-08-10T12:01:00.000Z",
): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role, content, timestamp: Date.parse(timestamp) },
	};
}

export async function writeSession(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}
