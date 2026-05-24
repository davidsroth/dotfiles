import { execFile, spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Optional env overrides (reload pi after changing them):
// - PI_DASHBOARD_LOCATION="San Francisco"
// - PI_DASHBOARD_TEMP_UNIT="F" | "C"
// - PI_DASHBOARD_EVENTS_COMMAND='echo "[{\"title\":\"Standup\",\"start\":\"2026-04-30T09:30:00-07:00\"}]"'
// - PI_DASHBOARD_PRS_DISABLED=1                # hide the PR section
// - PI_DASHBOARD_PR_LIMIT=3                    # number of PR rows (default 3)
// - PI_DASHBOARD_PRS_COMMAND='gh search prs ...' # custom JSON-producing command
// - PI_DASHBOARD_PR_OPENER='open -a Zen'       # opener cmd for `enter` in the picker (default: `open` on macOS, `xdg-open` elsewhere)
// - PI_DASHBOARD_PR_PICKER_KEY='ctrl+alt+p'    # shortcut to toggle the PR picker (default: ctrl+alt+p)
const WIDGET_ID = "dashboard-strip";
const RENDER_REFRESH_MS = 30_000;
const WEATHER_REFRESH_MS = 30 * 60_000;
const AGENDA_REFRESH_MS = 2 * 60_000;
const PRS_REFRESH_MS = 5 * 60_000;
const WEATHER_TIMEOUT_MS = 4_000;
const AGENDA_TIMEOUT_MS = 10_000;
const PRS_TIMEOUT_MS = 10_000;
const AGENDA_LOOKAHEAD_HOURS = 12;
const DEFAULT_PR_LIMIT = 3;
const PR_FETCH_LIMIT = 20;

const CUSTOM_EVENTS_COMMAND = process.env.PI_DASHBOARD_EVENTS_COMMAND?.trim();
const CUSTOM_PRS_COMMAND = process.env.PI_DASHBOARD_PRS_COMMAND?.trim();
const PRS_DISABLED = /^(1|true|yes|on)$/i.test(process.env.PI_DASHBOARD_PRS_DISABLED?.trim() ?? "");
const PR_LIMIT = (() => {
	const raw = process.env.PI_DASHBOARD_PR_LIMIT?.trim();
	if (!raw) return DEFAULT_PR_LIMIT;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PR_LIMIT;
	return Math.min(parsed, 8);
})();
const WEATHER_LOCATION = process.env.PI_DASHBOARD_LOCATION?.trim() || "New York";
const WEATHER_UNIT = process.env.PI_DASHBOARD_TEMP_UNIT?.trim()?.toUpperCase() || "F";
const PR_PICKER_KEY = process.env.PI_DASHBOARD_PR_PICKER_KEY?.trim() || "ctrl+alt+p";
const PR_OPENER = process.env.PI_DASHBOARD_PR_OPENER?.trim() || (process.platform === "darwin" ? "open" : "xdg-open");

const MACOS_CALENDAR_SWIFT = String.raw`
import Foundation
import EventKit

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)
var granted = false
var requestError: Error?

store.requestFullAccessToEvents { ok, error in
	granted = ok
	requestError = error
	semaphore.signal()
}

if semaphore.wait(timeout: .now() + 5) == .timedOut {
	fputs("Calendar access timed out\n", stderr)
	exit(1)
}

if let requestError {
	fputs("\(requestError.localizedDescription)\n", stderr)
	exit(1)
}

if !granted {
	fputs("Calendar access denied\n", stderr)
	exit(1)
}

let now = Date()
let horizon = now.addingTimeInterval(${AGENDA_LOOKAHEAD_HOURS} * 60 * 60)
let predicate = store.predicateForEvents(withStart: now, end: horizon, calendars: nil)
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

let items = store.events(matching: predicate)
	.sorted { $0.startDate < $1.startDate }
	.prefix(8)
	.map { event in
		[
			"title": event.title ?? "Untitled",
			"start": formatter.string(from: event.startDate),
			"end": formatter.string(from: event.endDate),
			"allDay": event.isAllDay ? "true" : "false",
			"calendar": event.calendar.title,
		]
	}

let normalized = items.map { item in
	[
		"title": item["title"] ?? "Untitled",
		"start": item["start"] ?? "",
		"end": item["end"] ?? "",
		"allDay": (item["allDay"] ?? "false") == "true",
		"calendar": item["calendar"] ?? "",
	]
}

let data = try JSONSerialization.data(withJSONObject: normalized, options: [])
FileHandle.standardOutput.write(data)
`;

type WeatherData = {
	temperature: string;
	condition: string;
	location: string;
	fetchedAt: number;
};

type AgendaEvent = {
	title: string;
	start: string;
	end?: string;
	allDay?: boolean;
	calendar?: string;
};

type PullRequest = {
	number: number;
	title: string;
	repo: string;
	url?: string;
	isDraft: boolean;
	updatedAt?: string;
};

type DashboardState = {
	weather?: WeatherData;
	weatherLoading: boolean;
	weatherError?: string;
	weatherFetchedAt?: number;
	agenda: AgendaEvent[];
	agendaLoading: boolean;
	agendaError?: string;
	agendaFetchedAt?: number;
	prs: PullRequest[];
	prsLoading: boolean;
	prsError?: string;
	prsFetchedAt?: number;
};

function execFileText(file: string, args: string[], timeout: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr.trim() || error.message));
				return;
			}
			resolve(stdout);
		});
	});
}

function padRight(text: string, width: number): string {
	const textWidth = visibleWidth(text);
	if (textWidth >= width) return truncateToWidth(text, width, "");
	return text + " ".repeat(width - textWidth);
}

function joinLeftRight(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + rightWidth + 2 > width) {
		return truncateToWidth(`${left}  ${right}`, width, "");
	}
	return left + " ".repeat(width - leftWidth - rightWidth) + right;
}

function renderRightColumn(text: string, columnWidth: number, totalWidth: number): string {
	const padded = padRight(text, columnWidth);
	if (columnWidth >= totalWidth) return truncateToWidth(padded, totalWidth, "");
	return " ".repeat(totalWidth - columnWidth) + padded;
}

function joinWithRightColumn(left: string, right: string, columnWidth: number, totalWidth: number): string {
	const gap = 2;
	const leftWidth = Math.max(0, totalWidth - columnWidth - gap);
	const leftPart = padRight(truncateToWidth(left, leftWidth, ""), leftWidth);
	const rightPart = padRight(right, columnWidth);
	return truncateToWidth(`${leftPart}${" ".repeat(gap)}${rightPart}`, totalWidth, "");
}

function preferredWeatherUnit(): "F" | "C" {
	if (WEATHER_UNIT === "F" || WEATHER_UNIT === "C") return WEATHER_UNIT;
	const locale = Intl.DateTimeFormat().resolvedOptions().locale;
	return locale.endsWith("-US") ? "F" : "C";
}

function formatClock(date: Date): string {
	return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function sanitizeText(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function parseAgendaJson(payload: string): AgendaEvent[] {
	const parsed = JSON.parse(payload) as unknown;
	if (!Array.isArray(parsed)) return [];

	const now = Date.now();
	const horizon = now + AGENDA_LOOKAHEAD_HOURS * 60 * 60 * 1000;

	return parsed
		.map((item) => {
			if (!item || typeof item !== "object") return undefined;
			const event = item as Record<string, unknown>;
			const title = sanitizeText(event.title, "Untitled");
			const start = typeof event.start === "string" ? new Date(event.start) : undefined;
			const end = typeof event.end === "string" ? new Date(event.end) : undefined;
			if (!start || Number.isNaN(start.getTime())) return undefined;
			if (end && Number.isNaN(end.getTime())) return undefined;
			return {
				title,
				start: start.toISOString(),
				end: end?.toISOString(),
				allDay: Boolean(event.allDay),
				calendar: typeof event.calendar === "string" ? event.calendar : undefined,
			} satisfies AgendaEvent;
		})
		.filter((event): event is AgendaEvent => Boolean(event))
		.filter((event) => {
			const start = new Date(event.start).getTime();
			const end = event.end ? new Date(event.end).getTime() : start;
			return end >= now && start <= horizon;
		})
		.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
		.slice(0, 8);
}

async function fetchWeather(): Promise<WeatherData> {
	const locationPath = WEATHER_LOCATION ? `/${encodeURIComponent(WEATHER_LOCATION)}` : "";
	const response = await fetch(`https://wttr.in${locationPath}?format=j1`, {
		headers: { "User-Agent": "pi-dashboard-widget" },
		signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Weather request failed (${response.status})`);

	const data = (await response.json()) as {
		current_condition?: Array<{
			temp_F?: string;
			temp_C?: string;
			weatherDesc?: Array<{ value?: string }>;
		}>;
		nearest_area?: Array<{
			areaName?: Array<{ value?: string }>;
		}>;
	};

	const current = data.current_condition?.[0];
	if (!current) throw new Error("Weather data missing current conditions");

	const unit = preferredWeatherUnit();
	const temperature = sanitizeText(unit === "F" ? current.temp_F : current.temp_C, "--");
	const condition = sanitizeText(current.weatherDesc?.[0]?.value, "Unknown");
	const location = sanitizeText(WEATHER_LOCATION ?? data.nearest_area?.[0]?.areaName?.[0]?.value, "Local weather");

	return {
		temperature: `${temperature}°`,
		condition,
		location,
		fetchedAt: Date.now(),
	};
}

async function fetchAgenda(): Promise<AgendaEvent[]> {
	if (CUSTOM_EVENTS_COMMAND) {
		const stdout = await execFileText(process.env.SHELL ?? "/bin/zsh", ["-lc", CUSTOM_EVENTS_COMMAND], AGENDA_TIMEOUT_MS);
		return parseAgendaJson(stdout);
	}

	const stdout = await execFileText("/usr/bin/swift", ["-e", MACOS_CALENDAR_SWIFT], AGENDA_TIMEOUT_MS);
	return parseAgendaJson(stdout);
}

function parsePrsJson(payload: string): PullRequest[] {
	const parsed = JSON.parse(payload) as unknown;
	if (!Array.isArray(parsed)) return [];

	return parsed
		.map((item) => {
			if (!item || typeof item !== "object") return undefined;
			const pr = item as Record<string, unknown>;
			const number = typeof pr.number === "number" ? pr.number : Number.parseInt(String(pr.number ?? ""), 10);
			if (!Number.isFinite(number)) return undefined;
			const title = sanitizeText(pr.title, "Untitled");
			const repoField = pr.repository;
			let repo = "";
			if (repoField && typeof repoField === "object") {
				const r = repoField as Record<string, unknown>;
				repo = sanitizeText(r.name ?? r.nameWithOwner, "");
			} else if (typeof repoField === "string") {
				repo = repoField;
			}
			if (repo.includes("/")) repo = repo.split("/").pop() ?? repo;
			return {
				number,
				title,
				repo,
				url: typeof pr.url === "string" ? pr.url : undefined,
				isDraft: Boolean(pr.isDraft),
				updatedAt: typeof pr.updatedAt === "string" ? pr.updatedAt : undefined,
			} satisfies PullRequest;
		})
		.filter((pr): pr is PullRequest => Boolean(pr))
		.sort((a, b) => {
			const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
			const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
			return bt - at;
		});
}

async function fetchPRs(): Promise<PullRequest[]> {
	if (CUSTOM_PRS_COMMAND) {
		const stdout = await execFileText(process.env.SHELL ?? "/bin/zsh", ["-lc", CUSTOM_PRS_COMMAND], PRS_TIMEOUT_MS);
		return parsePrsJson(stdout);
	}

	const stdout = await execFileText(
		"gh",
		[
			"search",
			"prs",
			"--author=@me",
			"--state=open",
			"--sort=updated",
			"--limit",
			String(PR_FETCH_LIMIT),
			"--json",
			"number,title,repository,url,isDraft,updatedAt",
		],
		PRS_TIMEOUT_MS,
	);
	return parsePrsJson(stdout);
}

function formatWeatherLine(theme: Theme, state: DashboardState): string {
	if (state.weather) {
		return `${theme.fg("accent", state.weather.temperature)} ${theme.fg("dim", "·")} ${theme.fg("muted", `${state.weather.condition} · ${state.weather.location}`)}`;
	}
	if (state.weatherLoading) return theme.fg("muted", "Loading weather…");
	return theme.fg("muted", "Weather unavailable");
}

function formatAgendaEntry(theme: Theme, label: string, event?: AgendaEvent): string {
	if (!event) return `${theme.fg("dim", label)} ${theme.fg("muted", "Free")}`;

	const start = new Date(event.start);
	const end = event.end ? new Date(event.end) : undefined;
	const now = Date.now();
	const inProgress = start.getTime() <= now && (!!end ? end.getTime() > now : false);

	if (event.allDay) {
		return `${theme.fg("dim", label)} ${theme.fg("muted", "All day")} ${theme.fg("text", event.title)}`;
	}

	if (inProgress && end) {
		return `${theme.fg("dim", label)} ${theme.fg("text", event.title)} ${theme.fg("dim", "· until")} ${theme.fg("muted", formatClock(end))}`;
	}

	return `${theme.fg("dim", label)} ${theme.fg("muted", formatClock(start))} ${theme.fg("text", event.title)}`;
}

function formatPrSummary(theme: Theme, state: DashboardState): string {
	if (state.prsLoading && state.prs.length === 0) {
		return `${theme.fg("dim", "PRs:")} ${theme.fg("muted", "Loading…")}`;
	}
	if (state.prsError && state.prs.length === 0) {
		return `${theme.fg("dim", "PRs:")} ${theme.fg("muted", "unavailable")}`;
	}
	const total = state.prs.length;
	if (total === 0) {
		return `${theme.fg("dim", "PRs:")} ${theme.fg("muted", "none open")}`;
	}
	const drafts = state.prs.filter((pr) => pr.isDraft).length;
	const ready = total - drafts;
	const parts = [`${total} open`];
	if (ready > 0) parts.push(`${ready} ready`);
	if (drafts > 0) parts.push(`${drafts} draft`);
	return `${theme.fg("dim", "PRs:")} ${theme.fg("accent", String(total))} ${theme.fg("dim", "·")} ${theme.fg("muted", parts.slice(1).join(" · ") || "open")}`;
}

function formatPrEntry(theme: Theme, pr: PullRequest): string {
	const marker = pr.isDraft ? theme.fg("dim", "◐") : theme.fg("accent", "●");
	const num = theme.fg("accent", `#${pr.number}`);
	const repo = pr.repo ? `${theme.fg("muted", pr.repo)} ${theme.fg("dim", "·")} ` : "";
	return `${marker} ${num} ${repo}${theme.fg("text", pr.title)}`;
}

function formatPrLines(theme: Theme, state: DashboardState): string[] {
	if (PR_LIMIT === 0) return [formatPrSummary(theme, state)];
	const lines: string[] = [formatPrSummary(theme, state)];
	const rows = state.prs.slice(0, PR_LIMIT);
	for (const pr of rows) {
		lines.push(formatPrEntry(theme, pr));
	}
	return lines;
}

function formatAgendaLines(theme: Theme, state: DashboardState): [string, string] {
	const now = Date.now();
	const visibleAgenda = state.agenda.filter((event) => {
		const start = new Date(event.start).getTime();
		const end = event.end ? new Date(event.end).getTime() : start;
		return end >= now;
	});

	if (visibleAgenda.length === 0) {
		if (state.agendaLoading) {
			return [
				`${theme.fg("dim", "Next:")} ${theme.fg("muted", "Loading calendar…")}`,
				`${theme.fg("dim", "Then:")} ${theme.fg("muted", "—")}`,
			];
		}
		if (state.agendaError) {
			return [
				`${theme.fg("dim", "Next:")} ${theme.fg("muted", "Calendar unavailable")}`,
				`${theme.fg("dim", "Then:")} ${theme.fg("muted", "—")}`,
			];
		}
		return [
			`${theme.fg("dim", "Next:")} ${theme.fg("muted", "No upcoming events")}`,
			`${theme.fg("dim", "Then:")} ${theme.fg("muted", "Free")}`,
		];
	}

	const [first, second] = visibleAgenda;
	const firstLabel = (() => {
		const start = new Date(first.start).getTime();
		const end = first.end ? new Date(first.end).getTime() : start;
		return start <= now && end > now ? "Now:" : "Next:";
	})();

	return [formatAgendaEntry(theme, firstLabel, first), formatAgendaEntry(theme, "Then:", second)];
}

function renderLines(theme: Theme, width: number, state: DashboardState): string[] {
	const now = new Date();
	const time = theme.bold(theme.fg("accent", formatClock(now)));
	const date = theme.fg("muted", now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }));
	const weather = formatWeatherLine(theme, state);
	const [next, then] = formatAgendaLines(theme, state);
	const prLines = PRS_DISABLED ? [] : formatPrLines(theme, state);

	if (width >= 80) {
		const agendaColumnWidth = Math.max(visibleWidth(next), visibleWidth(then));
		const lines = [
			joinLeftRight(date, time, width),
			joinWithRightColumn(weather, next, agendaColumnWidth, width),
			renderRightColumn(then, agendaColumnWidth, width),
		];
		if (prLines.length > 0) {
			lines.push(theme.fg("borderMuted", "─".repeat(width)));
			for (const line of prLines) lines.push(truncateToWidth(line, width, ""));
		}
		return lines;
	}

	const lines = [
		truncateToWidth(`${time} ${theme.fg("dim", "·")} ${date}`, width, ""),
		truncateToWidth(weather, width, ""),
		truncateToWidth(next, width, ""),
		truncateToWidth(then, width, ""),
	];
	if (prLines.length > 0) {
		lines.push(theme.fg("borderMuted", "─".repeat(width)));
		for (const line of prLines) lines.push(truncateToWidth(line, width, ""));
	}
	return lines;
}

export default function dashboardWidget(pi: ExtensionAPI) {
	let enabled = true;
	let visible = true;
	let prFocused = false;
	let activeRequestRender: (() => void) | undefined;
	let refreshTimer: NodeJS.Timeout | undefined;
	let weatherPromise: Promise<void> | undefined;
	let agendaPromise: Promise<void> | undefined;
	let prsPromise: Promise<void> | undefined;
	let activePickerRender: (() => void) | undefined;
	let activePickerDone: (() => void) | undefined;

	const state: DashboardState = {
		weatherLoading: true,
		agenda: [],
		agendaLoading: true,
		prs: [],
		prsLoading: !PRS_DISABLED,
	};

	function requestRender() {
		activeRequestRender?.();
		activePickerRender?.();
	}

	async function openPrPicker(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		if (prFocused) {
			activePickerDone?.();
			return;
		}

		// Kick off a refresh if we have nothing yet; otherwise refresh in the background
		// so the picker shows whatever's cached immediately but stays fresh.
		if (state.prs.length === 0 || !state.prsFetchedAt || Date.now() - state.prsFetchedAt >= PRS_REFRESH_MS) {
			void refreshPRs(true);
		}

		// Keep the dashboard widget rendered at its normal height while the overlay
		// is open. Hiding the PR section here changes the base layout height and can
		// pull the bottom bar upward, leaving blank space underneath in some states.
		prFocused = true;

		try {
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					activePickerRender = () => tui.requestRender();
					activePickerDone = () => done(undefined);
					let selected = 0;
					let scrollTop = 0;

					function list(): PullRequest[] {
						return state.prs;
					}

					function clampSelection(): void {
						const total = list().length;
						if (total === 0) {
							selected = 0;
							scrollTop = 0;
							return;
						}
						if (selected >= total) selected = total - 1;
						if (selected < 0) selected = 0;
					}

					function openSelected(): void {
						const pr = list()[selected];
						if (!pr?.url) {
							ctx.ui.notify("No URL for this PR", "warning");
							return;
						}
						try {
							const parts = PR_OPENER.split(/\s+/);
							const cmd = parts[0]!;
							const args = [...parts.slice(1), pr.url];
							const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
							child.on("error", (err) => ctx.ui.notify(`Failed to open: ${err.message}`, "error"));
							child.unref();
							ctx.ui.notify(`Opened #${pr.number}`, "info");
						} catch (error) {
							const msg = error instanceof Error ? error.message : String(error);
							ctx.ui.notify(`Failed to open: ${msg}`, "error");
							return;
						}
						done(undefined);
					}

					return {
						invalidate() {},
						render(width: number): string[] {
							clampSelection();
							const prs = list();
							const inner = Math.max(20, width - 2);

							// Match the widget's PR section format exactly, but with a selection cursor.
							const summary = formatPrSummary(theme, state);
							const bodyLines: string[] = [summary];

							if (state.prsLoading && prs.length === 0) {
								bodyLines.push(theme.fg("muted", "  Loading…"));
							} else if (state.prsError && prs.length === 0) {
								bodyLines.push(theme.fg("error", `  Error: ${state.prsError}`));
							} else if (prs.length === 0) {
								bodyLines.push(theme.fg("muted", "  No open PRs"));
							} else {
								const maxRows = Math.max(3, prs.length);
								if (selected < scrollTop) scrollTop = selected;
								if (selected >= scrollTop + maxRows) scrollTop = selected - maxRows + 1;
								const windowPrs = prs.slice(scrollTop, scrollTop + maxRows);
								for (let i = 0; i < windowPrs.length; i++) {
									const pr = windowPrs[i]!;
									const isSel = scrollTop + i === selected;
									const pointer = isSel ? theme.fg("accent", "▸") : " ";
									const marker = pr.isDraft ? theme.fg("dim", "◐") : theme.fg("accent", "●");
									const num = theme.fg("accent", `#${pr.number}`);
									const repo = pr.repo ? `${theme.fg("muted", pr.repo)} ${theme.fg("dim", "·")} ` : "";
									const title = isSel ? theme.bold(theme.fg("text", pr.title)) : theme.fg("text", pr.title);
									bodyLines.push(`${pointer} ${marker} ${num} ${repo}${title}`);
								}
							}

							const hint = theme.fg("dim", "tab/j/↓ next · shift-tab/k/↑ prev · enter open · r refresh · esc/shortcut exit");
							const paddedBody = bodyLines.map((line) => padRight(truncateToWidth(line, inner, "…"), inner));
							const paddedHint = padRight(truncateToWidth(hint, inner, "…"), inner);

							return [
								theme.fg("borderAccent", `╭${"─".repeat(inner)}╮`),
								...paddedBody.map((line) => theme.fg("borderAccent", "│") + line + theme.fg("borderAccent", "│")),
								theme.fg("borderAccent", "│") + paddedHint + theme.fg("borderAccent", "│"),
								theme.fg("borderAccent", `╰${"─".repeat(inner)}╯`),
							].map((line) => truncateToWidth(line, width, ""));
						},
						handleInput(data: string): void {
							if (matchesKey(data, Key.ctrlAlt("p")) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
								done(undefined);
								return;
							}
							if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.up) || data === "k") {
								if (selected > 0) {
									selected--;
									tui.requestRender();
								}
								return;
							}
							if (matchesKey(data, Key.tab) || matchesKey(data, Key.down) || data === "j") {
								if (selected < list().length - 1) {
									selected++;
									tui.requestRender();
								}
								return;
							}
							if (data === "g") {
								selected = 0;
								tui.requestRender();
								return;
							}
							if (data === "G") {
								selected = Math.max(0, list().length - 1);
								tui.requestRender();
								return;
							}
							if (matchesKey(data, Key.enter)) {
								if (list().length === 0) return;
								openSelected();
								return;
							}
							if (data === "r") {
								void refreshPRs(true);
								return;
							}
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						// Sit immediately above the editor, where the widget's PR section was.
						anchor: "bottom-center",
						width: "100%",
						margin: { left: 0, right: 0, bottom: 1, top: 0 },
					},
				},
			);
		} finally {
			prFocused = false;
			activePickerRender = undefined;
			activePickerDone = undefined;
			activeRequestRender?.();
		}
	}

	function stopRefreshTimer() {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
	}

	function shouldRefreshWeather(force = false): boolean {
		if (force) return true;
		if (!state.weatherFetchedAt) return true;
		return Date.now() - state.weatherFetchedAt >= WEATHER_REFRESH_MS;
	}

	function shouldRefreshAgenda(force = false): boolean {
		if (force) return true;
		if (!state.agendaFetchedAt) return true;
		return Date.now() - state.agendaFetchedAt >= AGENDA_REFRESH_MS;
	}

	function shouldRefreshPRs(force = false): boolean {
		if (PRS_DISABLED) return false;
		if (force) return true;
		if (!state.prsFetchedAt) return true;
		return Date.now() - state.prsFetchedAt >= PRS_REFRESH_MS;
	}

	function refreshWeather(force = false) {
		if (!shouldRefreshWeather(force)) return weatherPromise;
		if (weatherPromise) return weatherPromise;

		state.weatherLoading = true;
		requestRender();
		weatherPromise = (async () => {
			try {
				state.weather = await fetchWeather();
				state.weatherError = undefined;
			} catch (error) {
				state.weatherError = error instanceof Error ? error.message : String(error);
			} finally {
				state.weatherFetchedAt = Date.now();
				state.weatherLoading = false;
				weatherPromise = undefined;
				requestRender();
			}
		})();
		return weatherPromise;
	}

	function refreshAgenda(force = false) {
		if (!shouldRefreshAgenda(force)) return agendaPromise;
		if (agendaPromise) return agendaPromise;

		state.agendaLoading = true;
		requestRender();
		agendaPromise = (async () => {
			try {
				state.agenda = await fetchAgenda();
				state.agendaError = undefined;
			} catch (error) {
				state.agendaError = error instanceof Error ? error.message : String(error);
			} finally {
				state.agendaFetchedAt = Date.now();
				state.agendaLoading = false;
				agendaPromise = undefined;
				requestRender();
			}
		})();
		return agendaPromise;
	}

	function refreshPRs(force = false) {
		if (!shouldRefreshPRs(force)) return prsPromise;
		if (prsPromise) return prsPromise;

		state.prsLoading = true;
		requestRender();
		prsPromise = (async () => {
			try {
				state.prs = await fetchPRs();
				state.prsError = undefined;
			} catch (error) {
				state.prsError = error instanceof Error ? error.message : String(error);
			} finally {
				state.prsFetchedAt = Date.now();
				state.prsLoading = false;
				prsPromise = undefined;
				requestRender();
			}
		})();
		return prsPromise;
	}

	function refreshData(force = false) {
		void Promise.allSettled([refreshWeather(force), refreshAgenda(force), refreshPRs(force)]);
	}

	function startRefreshTimer() {
		stopRefreshTimer();
		refreshTimer = setInterval(() => {
			requestRender();
			refreshData();
		}, RENDER_REFRESH_MS);
	}

	function install(ctx: ExtensionContext) {
		if (!enabled || !visible) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}

		ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
			activeRequestRender = () => tui.requestRender();
			return {
				render(width: number): string[] {
					const innerWidth = Math.max(20, width - 2);
					const lines = renderLines(theme, innerWidth, state).map((line) => padRight(line, innerWidth));
					return [
						theme.fg("borderMuted", `╭${"─".repeat(innerWidth)}╮`),
						...lines.map((line) => theme.fg("borderMuted", "│") + line + theme.fg("borderMuted", "│")),
						theme.fg("borderMuted", `╰${"─".repeat(innerWidth)}╯`),
					].map((line) => truncateToWidth(line, width, ""));
				},
				invalidate() {},
			};
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		visible = enabled;
		install(ctx);
		startRefreshTimer();
		refreshData(true);
	});

	pi.on("input", (event, ctx) => {
		if (!visible) return { action: "continue" };
		if (!event.text.trim() && (!event.images || event.images.length === 0)) return { action: "continue" };
		visible = false;
		ctx.ui.setWidget(WIDGET_ID, undefined);
		stopRefreshTimer();
		return { action: "continue" };
	});

	pi.on("session_shutdown", () => {
		stopRefreshTimer();
		activeRequestRender = undefined;
		activePickerRender = undefined;
		activePickerDone = undefined;
		weatherPromise = undefined;
		agendaPromise = undefined;
		prsPromise = undefined;
	});

	pi.registerCommand("toggle-dashboard-widget", {
		description: "Toggle the compact startup widget above the editor",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			visible = enabled;
			install(ctx);
			if (enabled) {
				startRefreshTimer();
				refreshData(true);
				ctx.ui.notify("Dashboard widget enabled", "info");
			} else {
				stopRefreshTimer();
				ctx.ui.notify("Dashboard widget hidden", "info");
			}
		},
	});

	pi.registerCommand("refresh-dashboard-widget", {
		description: "Refresh weather, agenda, and PR data for the startup widget",
		handler: async (_args, ctx) => {
			refreshData(true);
			visible = enabled;
			install(ctx);
			ctx.ui.notify("Refreshing dashboard widget…", "info");
		},
	});

	pi.registerCommand("prs", {
		description: "Open the open-PR picker (tab/shift-tab or j/k navigate, enter opens in browser)",
		handler: async (_args, ctx) => {
			if (PRS_DISABLED) {
				ctx.ui.notify("PR section is disabled (PI_DASHBOARD_PRS_DISABLED)", "info");
				return;
			}
			await openPrPicker(ctx);
		},
	});

	if (!PRS_DISABLED) {
		pi.registerShortcut(PR_PICKER_KEY, {
			description: "Toggle the PR picker from the dashboard widget",
			handler: async (ctx) => {
				await openPrPicker(ctx);
			},
		});
	}
}
