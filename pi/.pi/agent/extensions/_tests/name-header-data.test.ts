/**
 * Tests for name-header/data.ts — IO/data layer for the dashboard widget.
 *
 * Hermetic: no real network, no real child processes, no real config reads.
 * globalThis.fetch is stubbed via vi.stubGlobal / vi.unstubAllGlobals.
 * node:child_process is mocked via vi.mock() hoisted at module scope.
 * config is mocked via vi.mock() to control constants that are baked at import time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- child_process mock (must be hoisted before any imports that use it) ---
vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

// --- config mock — override all env-derived constants ---
vi.mock("../name-header/config", () => ({
	WIDGET_ID: "dashboard-strip",
	RENDER_REFRESH_MS: 30_000,
	WEATHER_REFRESH_MS: 1_800_000,
	AGENDA_REFRESH_MS: 120_000,
	PRS_REFRESH_MS: 300_000,
	WEATHER_TIMEOUT_MS: 4_000,
	AGENDA_TIMEOUT_MS: 10_000,
	PRS_TIMEOUT_MS: 10_000,
	AGENDA_LOOKAHEAD_HOURS: 12,
	DEFAULT_PR_LIMIT: 3,
	PR_FETCH_LIMIT: 20,
	CUSTOM_EVENTS_COMMAND: undefined,
	CUSTOM_PRS_COMMAND: undefined,
	PRS_DISABLED: false,
	PR_LIMIT: 3,
	WEATHER_LOCATION: "New York",
	WEATHER_UNIT: "F",
	PR_PICKER_KEY: "ctrl+alt+p",
	PR_OPENER: "open",
	MACOS_CALENDAR_SWIFT: "/* swift placeholder */",
}));

import { execFile } from "node:child_process";
import {
	fetchAgenda,
	fetchPRs,
	closePR,
	fetchWeather,
	parseAgendaJson,
	parsePrsJson,
	preferredWeatherUnit,
} from "../name-header/data";

// Type cast for easy mock control
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

// Helper: build a minimal valid wttr.in j1 response
function makeWttrPayload(overrides?: {
	temp_F?: string | undefined;
	temp_C?: string | undefined;
	weatherDescValue?: string | undefined;
	nearest_area?: unknown;
	omitCurrentCondition?: boolean;
	emptyCurrentCondition?: boolean;
}) {
	const current_condition =
		overrides?.omitCurrentCondition || overrides?.emptyCurrentCondition
			? overrides.emptyCurrentCondition
				? []
				: undefined
			: [
					{
						temp_F: overrides?.temp_F ?? "72",
						temp_C: overrides?.temp_C ?? "22",
						weatherDesc: [{ value: overrides?.weatherDescValue ?? "Sunny" }],
					},
				];

	const base: Record<string, unknown> = {};
	if (!overrides?.omitCurrentCondition) {
		base.current_condition = current_condition;
	}
	if (overrides?.nearest_area !== undefined) {
		base.nearest_area = overrides.nearest_area;
	}
	return base;
}

// Helper: stub fetch to return a JSON payload
function stubFetchOk(payload: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve(payload),
		}),
	);
}

// Helper: stub fetch to return a non-ok response
function stubFetchError(status: number) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: false,
			status,
			json: () => {
				throw new Error("should not call json() on error response");
			},
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// fetchWeather — non-ok response
// ---------------------------------------------------------------------------
describe("fetchWeather — HTTP error", () => {
	it("throws 'Weather request failed (503)' on 503", async () => {
		stubFetchError(503);
		await expect(fetchWeather()).rejects.toThrow(/Weather request failed \(503\)/);
	});

	it("throws with the actual status code", async () => {
		stubFetchError(404);
		await expect(fetchWeather()).rejects.toThrow(/Weather request failed \(404\)/);
	});

	it("does not call response.json() when response.ok is false", async () => {
		const jsonSpy = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 500, json: jsonSpy }),
		);
		await expect(fetchWeather()).rejects.toThrow();
		expect(jsonSpy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// fetchWeather — missing current_condition
// ---------------------------------------------------------------------------
describe("fetchWeather — malformed payload", () => {
	it("throws 'Weather data missing current conditions' when current_condition absent", async () => {
		stubFetchOk({});
		await expect(fetchWeather()).rejects.toThrow("Weather data missing current conditions");
	});

	it("throws 'Weather data missing current conditions' when current_condition is empty array", async () => {
		stubFetchOk({ current_condition: [] });
		await expect(fetchWeather()).rejects.toThrow("Weather data missing current conditions");
	});
});

// ---------------------------------------------------------------------------
// fetchWeather — timeout (AbortSignal propagation)
// ---------------------------------------------------------------------------
describe("fetchWeather — timeout", () => {
	it("propagates a DOMException TimeoutError from fetch", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new DOMException("signal timed out", "TimeoutError")),
		);
		await expect(fetchWeather()).rejects.toThrow(/timed out/i);
	});
});

// ---------------------------------------------------------------------------
// fetchWeather — temperature unit selection (uses the mocked config WEATHER_UNIT='F')
// ---------------------------------------------------------------------------
describe("fetchWeather — temperature unit and field mapping", () => {
	it("returns temperature from temp_F when unit is F", async () => {
		stubFetchOk(makeWttrPayload({ temp_F: "72", temp_C: "22" }));
		const result = await fetchWeather();
		expect(result.temperature).toBe("72°");
	});

	it("returns a WeatherData shape with condition and location", async () => {
		stubFetchOk(makeWttrPayload({ weatherDescValue: "Partly Cloudy" }));
		const result = await fetchWeather();
		expect(result.condition).toBe("Partly Cloudy");
		expect(result.location).toBe("New York"); // from mocked WEATHER_LOCATION
	});
});

// ---------------------------------------------------------------------------
// fetchWeather — sanitizeText fallbacks
// ---------------------------------------------------------------------------
describe("fetchWeather — sanitizeText fallbacks", () => {
	it("falls back to '--' for temperature when temp_F is undefined", async () => {
		stubFetchOk({
			current_condition: [
				{
					// temp_F intentionally absent
					temp_C: "22",
					weatherDesc: [{ value: "Cloudy" }],
				},
			],
		});
		const result = await fetchWeather();
		expect(result.temperature).toBe("--°");
	});

	it("falls back to 'Unknown' for condition when weatherDesc value is whitespace", async () => {
		stubFetchOk({
			current_condition: [{ temp_F: "72", weatherDesc: [{ value: "   " }] }],
		});
		const result = await fetchWeather();
		expect(result.condition).toBe("Unknown");
	});
});

// ---------------------------------------------------------------------------
// preferredWeatherUnit — exported pure function
// ---------------------------------------------------------------------------
describe("preferredWeatherUnit", () => {
	// Note: because config is mocked at module scope with WEATHER_UNIT='F',
	// preferredWeatherUnit() returns 'F' directly (explicit override path).
	// Testing the locale path requires a separate import with different config mock,
	// which is not feasible in the same vitest module without unstable module reloads.
	// We test what we can from the mocked environment:
	it("returns 'F' when WEATHER_UNIT config is 'F' (explicit override)", () => {
		// config mock sets WEATHER_UNIT='F'
		expect(preferredWeatherUnit()).toBe("F");
	});
});

// ---------------------------------------------------------------------------
// parseAgendaJson — valid array filtering, sorting, capping
// ---------------------------------------------------------------------------
describe("parseAgendaJson — valid payload", () => {
	beforeEach(() => {
		// Fix the clock so time-window filtering is deterministic
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-01-15T12:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function hoursFromNow(h: number): string {
		return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
	}

	it("includes events within the 12h lookahead window", () => {
		const payload = JSON.stringify([
			{ title: "Meeting A", start: hoursFromNow(1), end: hoursFromNow(2) },
			{ title: "Meeting B", start: hoursFromNow(6), end: hoursFromNow(7) },
		]);
		const result = parseAgendaJson(payload);
		expect(result).toHaveLength(2);
		expect(result.map((e) => e.title)).toEqual(["Meeting A", "Meeting B"]);
	});

	it("excludes events that ended before now", () => {
		const payload = JSON.stringify([
			{ title: "Old Event", start: hoursFromNow(-3), end: hoursFromNow(-1) },
			{ title: "Future", start: hoursFromNow(1), end: hoursFromNow(2) },
		]);
		const result = parseAgendaJson(payload);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Future");
	});

	it("includes an event ending exactly at now (end >= now boundary)", () => {
		const payload = JSON.stringify([
			{ title: "Ends Now", start: hoursFromNow(-1), end: hoursFromNow(0) },
		]);
		const result = parseAgendaJson(payload);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Ends Now");
	});

	it("excludes events starting after the 12h horizon", () => {
		const payload = JSON.stringify([
			{ title: "Too Far", start: hoursFromNow(13), end: hoursFromNow(14) },
			{ title: "In Window", start: hoursFromNow(2), end: hoursFromNow(3) },
		]);
		const result = parseAgendaJson(payload);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("In Window");
	});

	it("sorts ascending by start time", () => {
		const payload = JSON.stringify([
			{ title: "Later", start: hoursFromNow(5), end: hoursFromNow(6) },
			{ title: "Earlier", start: hoursFromNow(1), end: hoursFromNow(2) },
			{ title: "Middle", start: hoursFromNow(3), end: hoursFromNow(4) },
		]);
		const result = parseAgendaJson(payload);
		expect(result.map((e) => e.title)).toEqual(["Earlier", "Middle", "Later"]);
	});

	it("caps results at 8 items", () => {
		const events = Array.from({ length: 10 }, (_, i) => ({
			title: `Event ${i}`,
			start: hoursFromNow(i + 0.5),
			end: hoursFromNow(i + 1),
		}));
		const result = parseAgendaJson(JSON.stringify(events));
		expect(result).toHaveLength(8);
	});

	it("maps allDay to Boolean correctly", () => {
		const payload = JSON.stringify([
			{ title: "All Day", start: hoursFromNow(1), allDay: true },
			{ title: "Not All Day", start: hoursFromNow(2), allDay: false },
			{ title: "Truthy String", start: hoursFromNow(3), allDay: "yes" },
		]);
		const result = parseAgendaJson(payload);
		expect(result[0].allDay).toBe(true);
		expect(result[1].allDay).toBe(false);
		expect(result[2].allDay).toBe(true); // Boolean("yes") === true
	});

	it("maps calendar only when it is a string", () => {
		const payload = JSON.stringify([
			{ title: "Has Calendar", start: hoursFromNow(1), calendar: "Work" },
			{ title: "Numeric Calendar", start: hoursFromNow(2), calendar: 42 },
		]);
		const result = parseAgendaJson(payload);
		expect(result[0].calendar).toBe("Work");
		expect(result[1].calendar).toBeUndefined();
	});

	it("includes ongoing events (started before now but end is in future)", () => {
		const payload = JSON.stringify([
			// started 30 min ago, ends in 30 min — end >= now, start <= horizon
			{ title: "Ongoing", start: hoursFromNow(-0.5), end: hoursFromNow(0.5) },
		]);
		const result = parseAgendaJson(payload);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Ongoing");
	});
});

// ---------------------------------------------------------------------------
// parseAgendaJson — invalid items are silently dropped
// ---------------------------------------------------------------------------
describe("parseAgendaJson — invalid start field", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-01-15T12:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("drops items with a non-date start string", () => {
		expect(parseAgendaJson('[{"title":"A","start":"not-a-date"}]')).toEqual([]);
	});

	it("drops items with no start field", () => {
		expect(parseAgendaJson('[{"title":"B"}]')).toEqual([]);
	});

	it("drops null items", () => {
		expect(parseAgendaJson("[null]")).toEqual([]);
	});

	it("drops primitive items", () => {
		expect(parseAgendaJson("[42]")).toEqual([]);
	});

	it("drops empty objects", () => {
		expect(parseAgendaJson("[{}]")).toEqual([]);
	});
});

describe("parseAgendaJson — invalid end field", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-01-15T12:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("drops items where end is present but not a valid date", () => {
		const start = new Date(Date.now() + 60_000).toISOString();
		const payload = JSON.stringify([{ title: "C", start, end: "garbage" }]);
		expect(parseAgendaJson(payload)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// parseAgendaJson — non-array top-level JSON
// ---------------------------------------------------------------------------
describe("parseAgendaJson — non-array JSON", () => {
	it("returns [] for object", () => {
		expect(parseAgendaJson('{"events":[]}')).toEqual([]);
	});

	it("returns [] for null", () => {
		expect(parseAgendaJson("null")).toEqual([]);
	});

	it("returns [] for string", () => {
		expect(parseAgendaJson('"string"')).toEqual([]);
	});

	it("returns [] for number", () => {
		expect(parseAgendaJson("42")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// parseAgendaJson — malformed JSON propagates as SyntaxError
// ---------------------------------------------------------------------------
describe("parseAgendaJson — malformed JSON", () => {
	it("throws SyntaxError for invalid JSON input", () => {
		expect(() => parseAgendaJson("not json at all")).toThrow(SyntaxError);
	});
});

// ---------------------------------------------------------------------------
// parsePrsJson — valid array, sorting, field mapping
// ---------------------------------------------------------------------------
describe("parsePrsJson — valid payload", () => {
	it("returns PRs sorted descending by updatedAt (newest first)", () => {
		const prs = [
			{
				number: 1,
				title: "Old PR",
				repository: { name: "repo" },
				url: "https://github.com/x/repo/pull/1",
				isDraft: false,
				updatedAt: "2024-01-10T00:00:00Z",
			},
			{
				number: 2,
				title: "New PR",
				repository: { name: "repo" },
				url: "https://github.com/x/repo/pull/2",
				isDraft: false,
				updatedAt: "2024-01-15T00:00:00Z",
			},
			{
				number: 3,
				title: "Middle PR",
				repository: { name: "repo" },
				url: "https://github.com/x/repo/pull/3",
				isDraft: false,
				updatedAt: "2024-01-12T00:00:00Z",
			},
		];
		const result = parsePrsJson(JSON.stringify(prs));
		expect(result.map((p) => p.number)).toEqual([2, 3, 1]);
	});

	it("maps number, title, repo, url, isDraft, updatedAt fields", () => {
		const prs = [
			{
				number: 42,
				title: "Fix bug",
				repository: { name: "my-repo" },
				url: "https://github.com/owner/my-repo/pull/42",
				isDraft: true,
				updatedAt: "2024-01-15T10:00:00Z",
			},
		];
		const result = parsePrsJson(JSON.stringify(prs));
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			number: 42,
			title: "Fix bug",
			repo: "my-repo",
			url: "https://github.com/owner/my-repo/pull/42",
			isDraft: true,
			updatedAt: "2024-01-15T10:00:00Z",
		});
	});

	it("does NOT cap results (no slice limit)", () => {
		const prs = Array.from({ length: 25 }, (_, i) => ({
			number: i + 1,
			title: `PR ${i + 1}`,
			repository: { name: "repo" },
			updatedAt: new Date(2024, 0, i + 1).toISOString(),
		}));
		const result = parsePrsJson(JSON.stringify(prs));
		expect(result).toHaveLength(25);
	});
});

// ---------------------------------------------------------------------------
// parsePrsJson — repo-name extraction
// ---------------------------------------------------------------------------
describe("parsePrsJson — repo-name extraction", () => {
	function makePr(repository: unknown) {
		return parsePrsJson(
			JSON.stringify([{ number: 1, title: "T", repository }]),
		);
	}

	it("extracts repo from repository.name", () => {
		expect(makePr({ name: "my-repo" })[0].repo).toBe("my-repo");
	});

	it("extracts last segment from repository.nameWithOwner (no name field)", () => {
		expect(makePr({ nameWithOwner: "owner/my-repo" })[0].repo).toBe("my-repo");
	});

	it("extracts last segment from repository string containing '/'", () => {
		expect(makePr("owner/my-repo")[0].repo).toBe("my-repo");
	});

	it("returns empty string when repository is empty object", () => {
		expect(makePr({})[0].repo).toBe("");
	});

	it("handles nameWithOwner when name is absent (uses ?? fallback)", () => {
		// name is undefined (not present), so ?? falls to nameWithOwner
		expect(makePr({ nameWithOwner: "acme/widget" })[0].repo).toBe("widget");
	});

	it("empty string name does NOT fall through to nameWithOwner (nullish coalescing semantics)", () => {
		// '' is not null/undefined, so ?? keeps '' — sanitizeText('', '') returns ''
		expect(makePr({ name: "", nameWithOwner: "owner/fallback" })[0].repo).toBe("");
	});
});

// ---------------------------------------------------------------------------
// parsePrsJson — invalid number field
// ---------------------------------------------------------------------------
describe("parsePrsJson — invalid number", () => {
	it("drops items where number is NaN after parseInt", () => {
		expect(parsePrsJson('[{"number":null,"title":"T"}]')).toEqual([]);
	});

	it("drops items with no number field", () => {
		expect(parsePrsJson('[{"title":"T"}]')).toEqual([]);
	});

	it("drops items with non-numeric string number", () => {
		expect(parsePrsJson('[{"number":"abc","title":"T"}]')).toEqual([]);
	});

	it("parses number from numeric string '42'", () => {
		const result = parsePrsJson('[{"number":"42","title":"PR","url":"https://github.com/x/y/pull/42"}]');
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// parsePrsJson — non-array top-level JSON
// ---------------------------------------------------------------------------
describe("parsePrsJson — non-array JSON", () => {
	it("returns [] for object", () => {
		expect(parsePrsJson("{}")).toEqual([]);
	});

	it("returns [] for null", () => {
		expect(parsePrsJson("null")).toEqual([]);
	});

	it("returns [] for string", () => {
		expect(parsePrsJson('"string"')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// parsePrsJson — missing updatedAt sorts last
// ---------------------------------------------------------------------------
describe("parsePrsJson — sort with missing updatedAt", () => {
	it("items without updatedAt sort last (treated as epoch 0)", () => {
		const prs = [
			{ number: 1, title: "No date" },
			{ number: 2, title: "Has date", updatedAt: "2024-01-15T00:00:00Z" },
		];
		const result = parsePrsJson(JSON.stringify(prs));
		expect(result[0].number).toBe(2);
		expect(result[1].number).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// execFileText — stderr preference over error.message
// ---------------------------------------------------------------------------
describe("execFileText (via fetchAgenda) — stderr preference", () => {
	it("uses stderr as rejection message when non-empty", async () => {
		mockExecFile.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, cb: (err: Error, stdout: string, stderr: string) => void) => {
			cb(new Error("fallback msg"), "", "stderr detail");
		});
		await expect(fetchAgenda()).rejects.toThrow("stderr detail");
	});

	it("falls back to error.message when stderr is empty", async () => {
		mockExecFile.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, cb: (err: Error, stdout: string, stderr: string) => void) => {
			cb(new Error("fallback msg"), "", "");
		});
		await expect(fetchAgenda()).rejects.toThrow("fallback msg");
	});
});

// ---------------------------------------------------------------------------
// fetchAgenda — timeout rejection
// ---------------------------------------------------------------------------
describe("fetchAgenda — timeout", () => {
	it("rejects when execFile calls back with an ETIMEDOUT error", async () => {
		mockExecFile.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, cb: (err: Error, stdout: string, stderr: string) => void) => {
			const err = Object.assign(new Error("spawn timeout"), { code: "ETIMEDOUT" });
			cb(err, "", "");
		});
		await expect(fetchAgenda()).rejects.toThrow("spawn timeout");
	});
});

// ---------------------------------------------------------------------------
// fetchAgenda — Swift fallback path (no CUSTOM_EVENTS_COMMAND in default mock)
// ---------------------------------------------------------------------------
describe("fetchAgenda — swift fallback", () => {
	it("calls /usr/bin/swift with -e when CUSTOM_EVENTS_COMMAND is unset", async () => {
		mockExecFile.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
			cb(null, "[]", "");
		});
		await fetchAgenda();
		expect(mockExecFile).toHaveBeenCalledWith(
			"/usr/bin/swift",
			expect.arrayContaining(["-e"]),
			expect.any(Object),
			expect.any(Function),
		);
		const call = mockExecFile.mock.calls[0] as unknown[];
		expect((call[1] as string[])[0]).toBe("-e");
	});
});

// ---------------------------------------------------------------------------
// fetchPRs — view-based args construction
// ---------------------------------------------------------------------------
describe("fetchPRs — view args", () => {
	beforeEach(() => {
		mockExecFile.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
			cb(null, "[]", "");
		});
	});

	function capturedArgs(): string[] {
		return mockExecFile.mock.calls[0][1] as string[];
	}

	it("appends --state=open for 'open' view", async () => {
		await fetchPRs("open");
		expect(capturedArgs()).toContain("--state=open");
	});

	it("appends --merged for 'merged' view", async () => {
		await fetchPRs("merged");
		expect(capturedArgs()).toContain("--merged");
	});

	it("appends --state=closed and -is:merged for 'closed' view", async () => {
		await fetchPRs("closed");
		const args = capturedArgs();
		expect(args).toContain("--state=closed");
		expect(args).toContain("-is:merged");
	});

	it("calls gh (not swift or shell) when CUSTOM_PRS_COMMAND is unset", async () => {
		await fetchPRs("open");
		expect(mockExecFile.mock.calls[0][0]).toBe("gh");
	});
});

// ---------------------------------------------------------------------------
// fetchPRs — timeout rejection
// ---------------------------------------------------------------------------
describe("fetchPRs — timeout", () => {
	it("rejects when execFile calls back with a timeout error", async () => {
		mockExecFile.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, cb: (err: Error, stdout: string, stderr: string) => void) => {
			const err = Object.assign(new Error("prs timeout"), { code: "ETIMEDOUT" });
			cb(err, "", "");
		});
		await expect(fetchPRs("open")).rejects.toThrow("prs timeout");
	});
});

// ---------------------------------------------------------------------------
// closePR — no URL throws synchronously
// ---------------------------------------------------------------------------
describe("closePR", () => {
	it("rejects with 'No URL for this PR' when url is falsy", async () => {
		await expect(
			closePR({ number: 1, title: "T", repo: "r", isDraft: false }),
		).rejects.toThrow("No URL for this PR");
	});

	it("calls gh pr close with the PR url and PRS_TIMEOUT_MS", async () => {
		mockExecFile.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
			cb(null, "", "");
		});
		const pr = {
			number: 1,
			title: "Fix",
			repo: "my-repo",
			url: "https://github.com/x/my-repo/pull/1",
			isDraft: false,
		};
		await closePR(pr);
		expect(mockExecFile).toHaveBeenCalledWith(
			"gh",
			["pr", "close", "https://github.com/x/my-repo/pull/1"],
			expect.objectContaining({ timeout: 10_000 }),
			expect.any(Function),
		);
	});
});
