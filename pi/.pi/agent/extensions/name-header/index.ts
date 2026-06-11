/**
 * name-header — a compact dashboard widget (clock, weather, agenda, PRs) drawn
 * above the editor at session start, plus an interactive PR picker overlay.
 *
 * This is the orchestration layer: it owns the mutable widget state and refresh
 * lifecycle, and wires pi events / commands / shortcuts. Pure helpers live in
 * sibling modules:
 *   - config.ts  — constants + env overrides
 *   - types.ts   — data shapes
 *   - data.ts    — IO (weather / calendar / gh)
 *   - render.ts  — pure presentation
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type KeyId, truncateToWidth } from "@earendil-works/pi-tui";
import { padRight } from "../_shared/tui";
import {
	AGENDA_REFRESH_MS,
	PR_PICKER_KEY,
	PRS_DISABLED,
	PRS_REFRESH_MS,
	RENDER_REFRESH_MS,
	WEATHER_REFRESH_MS,
	WIDGET_ID,
} from "./config";
import { fetchAgenda, fetchPRs, fetchWeather } from "./data";
import { PrPickerOverlay } from "./pr-picker";
import { renderLines } from "./render";
import { type DashboardState, PR_VIEWS, type PrListState, type PrView } from "./types";

export default function dashboardWidget(pi: ExtensionAPI) {
	let disposed = false;
	let enabled = true;
	let visible = true;
	let prFocused = false;
	let activeRequestRender: (() => void) | undefined;
	let refreshTimer: NodeJS.Timeout | undefined;
	let weatherPromise: Promise<void> | undefined;
	let agendaPromise: Promise<void> | undefined;
	const prsPromises: Partial<Record<PrView, Promise<void>>> = {};
	let activePickerRender: (() => void) | undefined;
	let activePickerDone: (() => void) | undefined;

	const state: DashboardState = {
		weatherLoading: true,
		agenda: [],
		agendaLoading: true,
		prs: [],
		prsLoading: !PRS_DISABLED,
	};
	const prLists: Record<PrView, PrListState> = {
		open: state,
		closed: { prs: [], prsLoading: false },
		merged: { prs: [], prsLoading: false },
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
			void refreshPRs("open", true);
		}

		// Keep the dashboard widget rendered at its normal height while the overlay
		// is open. Hiding the PR section here changes the base layout height and can
		// pull the bottom bar upward, leaving blank space underneath in some states.
		prFocused = true;

		try {
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const overlay = new PrPickerOverlay(
						tui,
						theme,
						{ prLists, refreshPRs, notify: (message, type) => ctx.ui.notify(message, type) },
						done,
					);
					activePickerRender = () => overlay.requestRender();
					activePickerDone = () => overlay.close();
					return overlay;
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

	function shouldRefreshPRs(view: PrView = "open", force = false): boolean {
		if (PRS_DISABLED) return false;
		if (force) return true;
		const listState = prLists[view];
		if (!listState.prsFetchedAt) return true;
		return Date.now() - listState.prsFetchedAt >= PRS_REFRESH_MS;
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
				weatherPromise = undefined;
				if (!disposed) {
					state.weatherFetchedAt = Date.now();
					state.weatherLoading = false;
					requestRender();
				}
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
				agendaPromise = undefined;
				if (!disposed) {
					state.agendaFetchedAt = Date.now();
					state.agendaLoading = false;
					requestRender();
				}
			}
		})();
		return agendaPromise;
	}

	function refreshPRs(view: PrView = "open", force = false) {
		if (!shouldRefreshPRs(view, force)) return prsPromises[view];
		if (prsPromises[view]) return prsPromises[view];

		const listState = prLists[view];
		listState.prsLoading = true;
		requestRender();
		prsPromises[view] = (async () => {
			try {
				listState.prs = await fetchPRs(view);
				listState.prsError = undefined;
			} catch (error) {
				listState.prsError = error instanceof Error ? error.message : String(error);
			} finally {
				prsPromises[view] = undefined;
				if (!disposed) {
					listState.prsFetchedAt = Date.now();
					listState.prsLoading = false;
					requestRender();
				}
			}
		})();
		return prsPromises[view];
	}

	function refreshData(force = false) {
		void Promise.allSettled([refreshWeather(force), refreshAgenda(force), refreshPRs("open", force)]);
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
		disposed = true;
		stopRefreshTimer();
		activeRequestRender = undefined;
		activePickerRender = undefined;
		activePickerDone = undefined;
		weatherPromise = undefined;
		agendaPromise = undefined;
		for (const view of PR_VIEWS) prsPromises[view] = undefined;
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
		description: "Open the PR picker",
		handler: async (_args, ctx) => {
			if (PRS_DISABLED) {
				ctx.ui.notify("PR section is disabled (PI_DASHBOARD_PRS_DISABLED)", "info");
				return;
			}
			await openPrPicker(ctx);
		},
	});

	if (!PRS_DISABLED) {
		pi.registerShortcut(PR_PICKER_KEY as KeyId, {
			description: "Toggle the PR picker from the dashboard widget",
			handler: async (ctx) => {
				await openPrPicker(ctx);
			},
		});
	}
}
