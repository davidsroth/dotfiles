import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActivityState } from "./agent-picker-util.js";

/**
 * Shared overlay chrome for the intercom UI. Every intercom surface (agent
 * picker, recipient picker, compose, inline message card) renders the same
 * subtle `borderAccent` rounded frame with the header/summary embedded in the
 * top edge, so they read as one family. Keep the visual language here; the
 * components only build their body lines.
 */

/** Inner content width (between the side borders) for a frame of `width`. */
export function innerWidth(width: number, min = 20): number {
  return Math.max(min, width - 2);
}

/** Pad `text` with spaces to exactly `width` visible columns (or truncate). */
export function padRight(text: string, width: number): string {
  const textWidth = visibleWidth(text);
  if (textWidth >= width) return truncateToWidth(text, width, "");
  return text + " ".repeat(width - textWidth);
}

/** Top border `╭─ title ─────╮` with the title baked into the edge. */
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

/**
 * Wrap pre-built body lines in a titled `borderAccent` rounded frame. Each body
 * line is padded/truncated to the inner width and flanked by side borders; the
 * whole frame is clipped to `width`. Every returned line has exactly `width`
 * visible columns.
 */
export function framedOverlay(theme: Theme, title: string, bodyLines: string[], width: number, minInner = 20): string[] {
  const inner = innerWidth(width, minInner);
  const side = theme.fg("borderAccent", "│");
  const body = bodyLines.map((line) => `${side}${padRight(truncateToWidth(line, inner, "…"), inner)}${side}`);
  return [
    topBorderWithTitle(theme, title, inner),
    ...body,
    theme.fg("borderAccent", `╰${"─".repeat(inner)}╯`),
  ].map((line) => truncateToWidth(line, width, ""));
}

/** Dim, `·`-separated hint line, e.g. `hintLine(theme, ["enter: send", "esc: cancel"])`. */
export function hintLine(theme: Theme, parts: string[]): string {
  return theme.fg("dim", parts.join(" · "));
}

/** Activity dot: filled `●` (active, accent), half `◐` (idle), hollow `○` (stale). */
export function activityMarker(theme: Theme, state: ActivityState): string {
  if (state === "active") return theme.fg("accent", "●");
  return theme.fg("dim", state === "stale" ? "○" : "◐");
}
