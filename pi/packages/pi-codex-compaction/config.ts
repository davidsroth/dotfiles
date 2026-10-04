import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 3600;

export function isValidTimeoutSeconds(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_TIMEOUT_SECONDS;
}

export interface CompactionConfig {
	timeoutSeconds: number;
	// Only used by the compatibility fallback for Pi before 0.84.4.
	autoCompact: boolean;
	thresholdRatio: number;
}

const DEFAULT_CONFIG: CompactionConfig = {
	timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
	autoCompact: true,
	thresholdRatio: 0.9,
};

function readConfig(path: string): Partial<CompactionConfig> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return {
			...(isValidTimeoutSeconds(parsed.timeoutSeconds) ? { timeoutSeconds: parsed.timeoutSeconds } : {}),
			...(typeof parsed.autoCompact === "boolean" ? { autoCompact: parsed.autoCompact } : {}),
			...(
				typeof parsed.thresholdRatio === "number" && parsed.thresholdRatio > 0 && parsed.thresholdRatio < 1
					? { thresholdRatio: parsed.thresholdRatio }
					: {}
			),
		};
	} catch {
		return {};
	}
}

export function loadCompactionConfig(cwd: string, projectTrusted: boolean): CompactionConfig {
	const globalConfig = readConfig(join(getAgentDir(), "pi-codex-compaction.json"));
	const projectConfig = projectTrusted
		? readConfig(join(cwd, CONFIG_DIR_NAME, "pi-codex-compaction.json"))
		: {};
	return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}
