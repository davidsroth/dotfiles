import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadCompactionConfig } from "./config.ts";

let root: string;
let cwd: string;
let globalPath: string;
let projectPath: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-compaction-config-"));
	cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	globalPath = join(agentDir, "pi-codex-compaction.json");
	projectPath = join(cwd, CONFIG_DIR_NAME, "pi-codex-compaction.json");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});
const writeConfig = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

describe("compaction configuration", () => {
	test("defaults to five minutes without changing legacy settings", () => {
		expect(loadCompactionConfig(cwd, false)).toEqual({ timeoutSeconds: 300, autoCompact: true, thresholdRatio: 0.9 });
	});

	test("honors the configured agent directory and merges trusted project values by field", () => {
		writeConfig(globalPath, { timeoutSeconds: 600, autoCompact: false, thresholdRatio: 0.8 });
		writeConfig(projectPath, { timeoutSeconds: 900 });
		expect(loadCompactionConfig(cwd, true)).toEqual({ timeoutSeconds: 900, autoCompact: false, thresholdRatio: 0.8 });
	});

	test("ignores project configuration without project trust", () => {
		writeConfig(globalPath, { timeoutSeconds: 600 });
		writeConfig(projectPath, { timeoutSeconds: 1, autoCompact: false });
		expect(loadCompactionConfig(cwd, false)).toEqual({ timeoutSeconds: 600, autoCompact: true, thresholdRatio: 0.9 });
	});

	test.each([1, 3600])("accepts timeout boundary %d", (timeoutSeconds) => {
		writeConfig(globalPath, { timeoutSeconds });
		expect(loadCompactionConfig(cwd, false).timeoutSeconds).toBe(timeoutSeconds);
	});

	test.each([0, -1, 1.5, 3601, 2 ** 31, "600", null, true, {}, []])("ignores invalid timeout %j without masking valid inherited values", (timeoutSeconds) => {
		writeConfig(globalPath, { timeoutSeconds });
		expect(loadCompactionConfig(cwd, true).timeoutSeconds).toBe(300);
		writeConfig(globalPath, { timeoutSeconds: 600 });
		writeConfig(projectPath, { timeoutSeconds, autoCompact: false });
		expect(loadCompactionConfig(cwd, true)).toEqual({ timeoutSeconds: 600, autoCompact: false, thresholdRatio: 0.9 });
	});

	test.each(["{", "null", "[]", "42", '"string"', '{"timeoutSeconds":1e999}'])("ignores malformed/non-object configuration %s", (text) => {
		writeFileSync(globalPath, text);
		expect(loadCompactionConfig(cwd, true).timeoutSeconds).toBe(300);
		writeConfig(globalPath, { timeoutSeconds: 600 });
		writeFileSync(projectPath, text);
		expect(loadCompactionConfig(cwd, true).timeoutSeconds).toBe(600);
	});

	test("rereads timeout configuration for subsequent attempts", () => {
		writeConfig(globalPath, { timeoutSeconds: 600 });
		expect(loadCompactionConfig(cwd, false).timeoutSeconds).toBe(600);
		writeConfig(globalPath, { timeoutSeconds: 900 });
		expect(loadCompactionConfig(cwd, false).timeoutSeconds).toBe(900);
	});
});
