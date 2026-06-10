/**
 * Tests for the pure redaction core of secret-guard.ts.
 *
 * Covers the high-precision patterns, the generic KEY=VALUE matcher, the
 * allowlist, custom extraPatterns, and the no-re-redaction invariant.
 * loadConfig() is intentionally untested — it reads the real layered config
 * from $HOME and would not be hermetic.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_PATTERNS,
	GENERIC_ASSIGNMENT,
	buildRedactOptions,
	redactContent,
	redactText,
	type RedactOptions,
	type SecretGuardConfig,
} from "../secret-guard";

function opts(over: Partial<RedactOptions> = {}): RedactOptions {
	return {
		patterns: DEFAULT_PATTERNS,
		generic: true,
		placeholder: "[REDACTED]",
		includePatternName: true,
		allowlist: new Set<string>(),
		...over,
	};
}

describe("DEFAULT_PATTERNS", () => {
	const cases: Array<[name: string, sample: string]> = [
		["openai-anthropic-key", "sk-ant-api03-abc123def456ghi789"],
		["stripe-key", "sk_live_abcdefghijklmnop1234"],
		["aws-access-key-id", "AKIAABCDEFGHIJKLMNOP"],
		["github-token", "ghp_" + "A1b2C3d4".repeat(5)],
		["github-pat", "github_pat_" + "x".repeat(30)],
		["gitlab-token", "glpat-abcdefghij1234567890"],
		["slack-token", "xoxb-1234567890-abcdefghij"],
		["google-api-key", "AIza" + "B".repeat(35)],
		["google-oauth-secret", "GOCSPX-abcdefghij0123456789"],
		["npm-token", "npm_" + "a1".repeat(18)],
		["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4"],
	];

	it.each(cases)("masks %s", (name, sample) => {
		const { text, hits } = redactText(`before ${sample} after`, opts());
		expect(text).toBe(`before [REDACTED:${name}] after`);
		expect(hits[name]).toBe(1);
	});

	it("masks multi-line private key blocks", () => {
		const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
		const { text, hits } = redactText(key, opts());
		expect(text).toBe("[REDACTED:private-key]");
		expect(hits["private-key"]).toBe(1);
	});

	it("keeps the Bearer label, masks only the token", () => {
		const { text } = redactText("Authorization: Bearer abcdefghijklmnop123456", opts());
		expect(text).toBe("Authorization: Bearer [REDACTED:bearer-token]");
	});

	it("leaves ordinary text alone", () => {
		const input = "nothing secret here, just a sentence with skis and tokens of appreciation";
		const { text, hits } = redactText(input, opts());
		expect(text).toBe(input);
		expect(hits).toEqual({});
	});
});

describe("GENERIC_ASSIGNMENT", () => {
	it("masks the value, keeps key + separator + quotes", () => {
		const { text } = redactText('db_password = "hunter2hunter2hunter2"', opts());
		expect(text).toBe('db_password = "[REDACTED:credential-assignment]"');
	});

	it("handles colon separators and unquoted values", () => {
		const { text } = redactText("api_key: abcdefgh12345678", opts());
		expect(text).toBe("api_key: [REDACTED:credential-assignment]");
	});

	it("ignores short values (< 12 chars)", () => {
		const input = "password = short123";
		expect(redactText(input, opts()).text).toBe(input);
	});

	it("is skipped when generic is off", () => {
		const input = 'db_password = "hunter2hunter2hunter2"';
		expect(redactText(input, opts({ generic: false })).text).toBe(input);
	});

	it("does not re-match an existing placeholder (idempotence)", () => {
		const first = redactText('token = "abcdefghijklmnopqrst"', opts());
		const second = redactText(first.text, opts());
		expect(second.text).toBe(first.text);
		expect(second.hits).toEqual({});
	});
});

describe("options", () => {
	it("uses the bare placeholder when includePatternName is off", () => {
		const { text } = redactText("xoxb-1234567890-abcdefghij", opts({ includePatternName: false }));
		expect(text).toBe("[REDACTED]");
	});

	it("allowlist preserves a whole-match secret", () => {
		const secret = "xoxb-1234567890-abcdefghij";
		const { text, hits } = redactText(secret, opts({ allowlist: new Set([secret]) }));
		expect(text).toBe(secret);
		expect(hits).toEqual({});
	});

	it("allowlist matches the value group for render-style patterns", () => {
		const token = "abcdefghijklmnop123456";
		const { text } = redactText(`Bearer ${token}`, opts({ allowlist: new Set([token]) }));
		expect(text).toBe(`Bearer ${token}`);
	});
});

describe("buildRedactOptions", () => {
	const baseCfg: SecretGuardConfig = {
		enabled: true,
		mode: "redact",
		genericAssignments: true,
		includePatternName: true,
		notify: false,
		placeholder: "[REDACTED]",
		extraPatterns: [],
		allowlist: [],
		blockTools: ["bash"],
	};

	it("compiles extraPatterns and applies them as 'custom'", () => {
		const o = buildRedactOptions({ ...baseCfg, extraPatterns: ["distyl-[a-z0-9]{10}"] });
		expect(o.patterns).toHaveLength(DEFAULT_PATTERNS.length + 1);
		const { text } = redactText("found distyl-abc123def4 in env", o);
		expect(text).toBe("found [REDACTED:custom] in env");
	});

	it("skips invalid extraPatterns instead of throwing", () => {
		const o = buildRedactOptions({ ...baseCfg, extraPatterns: ["(unclosed"] });
		expect(o.patterns).toHaveLength(DEFAULT_PATTERNS.length);
	});

	it("builds the allowlist as a set", () => {
		const o = buildRedactOptions({ ...baseCfg, allowlist: ["keep-me"] });
		expect(o.allowlist.has("keep-me")).toBe(true);
	});
});

describe("redactContent", () => {
	it("rewrites only text blocks, leaves image blocks alone", () => {
		const image = { type: "image", data: "AAAA", mimeType: "image/png" };
		const blocks = [
			{ type: "text", text: "key sk-ant-abc123def456ghi789 leaked" },
			image,
		// biome-ignore lint/suspicious/noExplicitAny: structural stand-in for pi-ai content blocks
		] as any;
		const result = redactContent(blocks, opts());
		expect(result.changed).toBe(true);
		expect(result.totalHits).toBe(1);
		expect(result.content[1]).toBe(image);
		expect((result.content[0] as { text: string }).text).toContain("[REDACTED:openai-anthropic-key]");
	});

	it("reports changed=false and keeps the original array when clean", () => {
		// biome-ignore lint/suspicious/noExplicitAny: structural stand-in for pi-ai content blocks
		const blocks = [{ type: "text", text: "all clear" }] as any;
		const result = redactContent(blocks, opts());
		expect(result.changed).toBe(false);
		expect(result.content).toBe(blocks);
		expect(result.totalHits).toBe(0);
	});
});
