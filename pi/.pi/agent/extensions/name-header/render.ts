/**
 * render.ts — pure presentation layer. Given a theme + state, produce the lines
 * the widget and PR picker draw. No IO, no mutable state.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { padRight } from "../_shared/tui";
import { PR_LIMIT, PRS_DISABLED } from "./config";
import type { AgendaEvent, DashboardState, PrListState, PrView, PullRequest } from "./types";

export function topBorderWithTitle(theme: Theme, title: string, inner: number): string {
	const accent = (text: string) => theme.fg("borderAccent", text);
	const maxTitleWidth = Math.max(0, inner - 4);
	let padded = ` ${title} `;
	if (visibleWidth(padded) > maxTitleWidth) {
		padded = ` ${truncateToWidth(title, Math.max(1, maxTitleWidth - 2), "…")} `;
	}
	const tail = Math.max(1, inner - 1 - visibleWidth(padded));
	return `${accent("╭─")}${padded}${accent("─".repeat(tail))}${accent("╮")}`;
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

function formatClock(date: Date): string {
	return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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

export function formatPrSummary(theme: Theme, state: PrListState, view: PrView = "open"): string {
	const label = view === "open" ? "PRs:" : `${view[0]!.toUpperCase()}${view.slice(1)}:`;
	if (state.prsLoading && state.prs.length === 0) {
		return `${theme.fg("dim", label)} ${theme.fg("muted", "Loading…")}`;
	}
	if (state.prsError && state.prs.length === 0) {
		return `${theme.fg("dim", label)} ${theme.fg("muted", "unavailable")}`;
	}
	const total = state.prs.length;
	if (total === 0) {
		return `${theme.fg("dim", label)} ${theme.fg("muted", `none ${view}`)}`;
	}
	if (view !== "open") {
		return `${theme.fg("dim", label)} ${theme.fg("accent", String(total))}`;
	}
	const drafts = state.prs.filter((pr) => pr.isDraft).length;
	const ready = total - drafts;
	const parts = [`${total} open`];
	if (ready > 0) parts.push(`${ready} ready`);
	if (drafts > 0) parts.push(`${drafts} draft`);
	return `${theme.fg("dim", label)} ${theme.fg("accent", String(total))} ${theme.fg("dim", "·")} ${theme.fg("muted", parts.slice(1).join(" · ") || "open")}`;
}

function formatPrEntry(theme: Theme, pr: PullRequest): string {
	const marker = pr.isDraft ? theme.fg("dim", "◐") : theme.fg("accent", "●");
	const num = theme.fg("accent", `#${pr.number}`);
	const repo = pr.repo ? `${theme.fg("muted", pr.repo)} ${theme.fg("dim", "·")} ` : "";
	return `${marker} ${num} ${repo}${theme.fg("text", pr.title)}`;
}

function formatPrLines(theme: Theme, state: PrListState, view: PrView = "open"): string[] {
	if (PR_LIMIT === 0) return [formatPrSummary(theme, state, view)];
	const lines: string[] = [formatPrSummary(theme, state, view)];
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

export function renderLines(theme: Theme, width: number, state: DashboardState): string[] {
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
