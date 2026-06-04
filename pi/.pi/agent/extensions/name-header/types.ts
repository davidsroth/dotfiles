/**
 * types.ts — shared data shapes for the dashboard widget.
 */

export type WeatherData = {
	temperature: string;
	condition: string;
	location: string;
	fetchedAt: number;
};

export type AgendaEvent = {
	title: string;
	start: string;
	end?: string;
	allDay?: boolean;
	calendar?: string;
};

export type PullRequest = {
	number: number;
	title: string;
	repo: string;
	url?: string;
	isDraft: boolean;
	updatedAt?: string;
};

export type PrView = "open" | "closed" | "merged";

export type PrListState = {
	prs: PullRequest[];
	prsLoading: boolean;
	prsError?: string;
	prsFetchedAt?: number;
};

export const PR_VIEWS: PrView[] = ["open", "closed", "merged"];

export type DashboardState = {
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
