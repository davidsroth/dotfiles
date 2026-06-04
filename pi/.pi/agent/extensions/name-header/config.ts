/**
 * config.ts — constants and env-derived configuration for the dashboard widget.
 *
 * Optional env overrides (reload pi after changing them):
 * - PI_DASHBOARD_LOCATION="San Francisco"
 * - PI_DASHBOARD_TEMP_UNIT="F" | "C"
 * - PI_DASHBOARD_EVENTS_COMMAND='echo "[{\"title\":\"Standup\",\"start\":\"2026-04-30T09:30:00-07:00\"}]"'
 * - PI_DASHBOARD_PRS_DISABLED=1                # hide the PR section
 * - PI_DASHBOARD_PR_LIMIT=3                    # number of PR rows (default 3)
 * - PI_DASHBOARD_PRS_COMMAND='gh search prs ...' # custom JSON-producing command
 * - PI_DASHBOARD_PR_OPENER='open -a Zen'       # opener cmd for `enter` in the picker (default: `open` on macOS, `xdg-open` elsewhere)
 * - PI_DASHBOARD_PR_PICKER_KEY='ctrl+alt+p'    # shortcut to toggle the PR picker (default: ctrl+alt+p)
 */

export const WIDGET_ID = "dashboard-strip";
export const RENDER_REFRESH_MS = 30_000;
export const WEATHER_REFRESH_MS = 30 * 60_000;
export const AGENDA_REFRESH_MS = 2 * 60_000;
export const PRS_REFRESH_MS = 5 * 60_000;
export const WEATHER_TIMEOUT_MS = 4_000;
export const AGENDA_TIMEOUT_MS = 10_000;
export const PRS_TIMEOUT_MS = 10_000;
export const AGENDA_LOOKAHEAD_HOURS = 12;
export const DEFAULT_PR_LIMIT = 3;
export const PR_FETCH_LIMIT = 20;

export const CUSTOM_EVENTS_COMMAND = process.env.PI_DASHBOARD_EVENTS_COMMAND?.trim();
export const CUSTOM_PRS_COMMAND = process.env.PI_DASHBOARD_PRS_COMMAND?.trim();
export const PRS_DISABLED = /^(1|true|yes|on)$/i.test(process.env.PI_DASHBOARD_PRS_DISABLED?.trim() ?? "");
export const PR_LIMIT = (() => {
	const raw = process.env.PI_DASHBOARD_PR_LIMIT?.trim();
	if (!raw) return DEFAULT_PR_LIMIT;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PR_LIMIT;
	return Math.min(parsed, 8);
})();
export const WEATHER_LOCATION = process.env.PI_DASHBOARD_LOCATION?.trim() || "New York";
export const WEATHER_UNIT = process.env.PI_DASHBOARD_TEMP_UNIT?.trim()?.toUpperCase() || "F";
export const PR_PICKER_KEY = process.env.PI_DASHBOARD_PR_PICKER_KEY?.trim() || "ctrl+alt+p";
export const PR_OPENER =
	process.env.PI_DASHBOARD_PR_OPENER?.trim() || (process.platform === "darwin" ? "open" : "xdg-open");

export const MACOS_CALENDAR_SWIFT = String.raw`
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
