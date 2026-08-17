import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActivityState } from "./agent-picker-util.ts";

function padRight(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function framedPicker(theme: Theme, title: string, body: string[], width: number): string[] {
  if (width <= 0) return [];
  if (width === 1) return [theme.fg("borderAccent", "│")];

  const inner = width - 2;
  const border = (text: string) => theme.fg("borderAccent", text);
  const maxTitleWidth = Math.max(0, inner - 3);
  const label = maxTitleWidth > 0 ? ` ${truncateToWidth(title, maxTitleWidth, "…")} ` : "";
  const tail = "─".repeat(Math.max(0, inner - 1 - visibleWidth(label)));
  const lines = [
    `${border("╭─")}${label}${border(`${tail}╮`)}`,
    ...body.map((line) => `${border("│")}${padRight(line, inner)}${border("│")}`),
    border(`╰${"─".repeat(inner)}╯`),
  ];
  return lines.map((line) => truncateToWidth(line, width, ""));
}

export function activityMarker(theme: Theme, state: ActivityState): string {
  if (state === "active") return theme.fg("accent", "●");
  return theme.fg("dim", state === "stale" ? "○" : "◐");
}
