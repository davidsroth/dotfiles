/**
 * data.ts — IO/data layer for the dashboard widget: shells out to weather,
 * calendar, and `gh`, and parses their output into typed shapes.
 */

import { execFile } from "node:child_process";
import {
	AGENDA_LOOKAHEAD_HOURS,
	AGENDA_TIMEOUT_MS,
	CUSTOM_EVENTS_COMMAND,
	CUSTOM_PRS_COMMAND,
	MACOS_CALENDAR_SWIFT,
	PR_FETCH_LIMIT,
	PRS_TIMEOUT_MS,
	WEATHER_LOCATION,
	WEATHER_TIMEOUT_MS,
	WEATHER_UNIT,
} from "./config";
import type { AgendaEvent, PrView, PullRequest, WeatherData } from "./types";

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

function preferredWeatherUnit(): "F" | "C" {
	if (WEATHER_UNIT === "F" || WEATHER_UNIT === "C") return WEATHER_UNIT;
	const locale = Intl.DateTimeFormat().resolvedOptions().locale;
	return locale.endsWith("-US") ? "F" : "C";
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
		.map((item): AgendaEvent | undefined => {
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

export async function fetchWeather(): Promise<WeatherData> {
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

export async function fetchAgenda(): Promise<AgendaEvent[]> {
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
		.map((item): PullRequest | undefined => {
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

export async function fetchPRs(view: PrView = "open"): Promise<PullRequest[]> {
	if (CUSTOM_PRS_COMMAND) {
		const stdout = await execFileText(process.env.SHELL ?? "/bin/zsh", ["-lc", CUSTOM_PRS_COMMAND], PRS_TIMEOUT_MS);
		return parsePrsJson(stdout);
	}

	const args = [
		"search",
		"prs",
		"--author=@me",
		"--sort=updated",
		"--limit",
		String(PR_FETCH_LIMIT),
		"--json",
		"number,title,repository,url,isDraft,updatedAt",
	];
	if (view === "open") {
		args.push("--state=open");
	} else if (view === "merged") {
		args.push("--merged");
	} else {
		args.push("--state=closed", "--", "-is:merged");
	}

	const stdout = await execFileText("gh", args, PRS_TIMEOUT_MS);
	return parsePrsJson(stdout);
}

export async function closePR(pr: PullRequest): Promise<void> {
	if (!pr.url) throw new Error("No URL for this PR");
	await execFileText("gh", ["pr", "close", pr.url], PRS_TIMEOUT_MS);
}
