import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { SessionInfo } from "../types.js";
import { activityState, formatAge } from "./agent-picker-util.js";

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export function middleTruncate(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return truncateToWidth(text, maxWidth, "");

  const chars = [...text];
  const side = Math.max(1, Math.floor((maxWidth - 1) / 2));
  let left = "";
  for (const char of chars) {
    if (visibleWidth(left + char) > side) break;
    left += char;
  }
  let right = "";
  for (const char of chars.slice().reverse()) {
    if (visibleWidth(char + right) > side) break;
    right = char + right;
  }
  return truncateToWidth(`${left}…${right}`, maxWidth, "");
}

function padRight(text: string, width: number): string {
  const textWidth = visibleWidth(text);
  if (textWidth >= width) return truncateToWidth(text, width, "");
  return text + " ".repeat(width - textWidth);
}

function topBorderWithTitle(theme: Theme, title: string, inner: number): string {
  const accent = (text: string) => theme.fg("borderAccent", text);
  const maxTitleWidth = Math.max(0, inner - 4);
  let padded = ` ${title} `;
  if (visibleWidth(padded) > maxTitleWidth) {
    padded = ` ${truncateToWidth(title, Math.max(1, maxTitleWidth - 2), "…")} `;
  }
  const tail = Math.max(1, inner - 1 - visibleWidth(padded));
  return `${accent("╭─")}${padded}${accent("─".repeat(tail))}${accent("╮")}`;
}

function sessionName(session: SessionInfo): string {
  return session.name || "Unnamed session";
}

export function cwdLabel(cwd: string): string {
  const trimmed = cwd.replace(/\/$/, "");
  return trimmed.split("/").filter(Boolean).pop() || cwd || "?";
}

export class AgentPickerOverlay implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private currentSession: SessionInfo;
  private sessions: SessionInfo[];
  private done: (result: SessionInfo | undefined) => void;
  private selected = 0;
  private scrollTop = 0;
  private maxVisibleRows = 12;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    currentSession: SessionInfo,
    sessions: SessionInfo[],
    done: (result: SessionInfo | undefined) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.currentSession = currentSession;
    this.sessions = sessions;
    this.done = done;
  }

  invalidate(): void {}

  /**
   * Replace the session list while the overlay is open (driven by broker
   * join/leave/presence events). Preserves the user's selection by id across
   * the re-sort and requests a redraw so the change is visible immediately.
   */
  setSessions(sessions: SessionInfo[]): void {
    const selectedId = this.sessions[this.selected]?.id;
    this.sessions = sessions;
    if (selectedId) {
      const index = this.sessions.findIndex((session) => session.id === selectedId);
      this.selected = index >= 0 ? index : Math.min(this.selected, Math.max(0, this.sessions.length - 1));
    } else {
      this.selected = 0;
    }
    this.tui.requestRender();
  }

  private selectedSession(): SessionInfo | undefined {
    return this.sessions[this.selected];
  }

  private move(delta: number): void {
    const total = this.sessions.length;
    if (total === 0) return;
    this.selected = (this.selected + delta + total) % total;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.ctrlAlt("a"))
      || matchesKey(data, Key.escape)
      || matchesKey(data, Key.ctrl("c"))
      || data === "q"
    ) {
      this.done(undefined);
      return;
    }

    if (this.sessions.length === 0) return;

    if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.up) || data === "k") {
      this.move(-1);
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.down) || data === "j") {
      this.move(1);
      return;
    }

    if (data === "g") {
      this.selected = 0;
      return;
    }

    if (data === "G") {
      this.selected = this.sessions.length - 1;
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      const session = this.selectedSession();
      if (session) this.done(session);
    }
  }

  private formatSummary(): string {
    const now = Date.now();
    const active = this.sessions.filter((session) => activityState(session, now) === "active").length;
    const stale = this.sessions.filter((session) => activityState(session, now) === "stale").length;
    const idle = this.sessions.length - active - stale;
    const stalePart = stale > 0 ? `${this.theme.fg("dim", " · ")}${this.theme.fg("muted", `${stale} stale`)}` : "";
    return `${this.theme.fg("dim", "Agents:")} ${this.theme.fg("accent", String(this.sessions.length))} ${this.theme.fg("muted", "connected")} ${this.theme.fg("dim", "·")} ${this.theme.fg("accent", String(active))} ${this.theme.fg("muted", "active")} ${this.theme.fg("dim", "·")} ${this.theme.fg("muted", `${idle} idle`)}${stalePart}`;
  }

  private formatRow(session: SessionInfo, isSelected: boolean, inner: number): string {
    const stateKind = activityState(session);
    const statusText = session.status || "idle";
    const pointer = isSelected ? this.theme.fg("accent", "▸") : " ";
    const marker = stateKind === "active" ? this.theme.fg("accent", "●") : this.theme.fg("dim", stateKind === "stale" ? "○" : "◐");
    const state = stateKind === "active"
      ? this.theme.fg("accent", statusText)
      : this.theme.fg("muted", stateKind === "stale" ? `stale ${statusText}` : "idle");
    const self = session.id === this.currentSession.id ? this.theme.fg("dim", " [self]") : "";
    const titleText = `${sessionName(session)} (${shortSessionId(session.id)})`;
    const title = isSelected ? this.theme.bold(this.theme.fg("text", titleText)) : this.theme.fg("text", titleText);
    const project = this.theme.fg("muted", cwdLabel(session.cwd));
    const status = stateKind === "stale"
      ? `${this.theme.fg("dim", " · ")}${this.theme.fg("muted", `last update ${formatAge(session.lastActivity)}`)}`
      : "";
    const model = `${this.theme.fg("dim", " · ")}${this.theme.fg("muted", session.model)}`;
    const cwdBudget = Math.max(10, Math.min(32, Math.floor(inner / 4)));
    const path = this.theme.fg("dim", ` (${middleTruncate(session.cwd, cwdBudget)})`);

    return `${pointer} ${marker} ${state} ${title}${self} ${this.theme.fg("dim", "·")} ${project}${path}${model}${status}`;
  }

  render(width: number): string[] {
    const inner = Math.max(20, width - 2);
    const bodyLines: string[] = [
      this.theme.fg("dim", "enter: switch · tab/j/down: next · shift-tab/k/up: previous · q/esc: close"),
    ];

    if (this.sessions.length === 0) {
      bodyLines.push(this.theme.fg("muted", "  No intercom-connected Pi sessions"));
    } else {
      if (this.selected < 0) this.selected = 0;
      if (this.selected >= this.sessions.length) this.selected = this.sessions.length - 1;
      const maxRows = Math.min(this.maxVisibleRows, Math.max(3, this.sessions.length));
      if (this.selected < this.scrollTop) this.scrollTop = this.selected;
      if (this.selected >= this.scrollTop + maxRows) this.scrollTop = this.selected - maxRows + 1;
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, this.sessions.length - maxRows)));

      const windowSessions = this.sessions.slice(this.scrollTop, this.scrollTop + maxRows);
      for (let index = 0; index < windowSessions.length; index++) {
        const absoluteIndex = this.scrollTop + index;
        bodyLines.push(this.formatRow(windowSessions[index]!, absoluteIndex === this.selected, inner));
      }

      if (this.scrollTop > 0 || this.scrollTop + maxRows < this.sessions.length) {
        bodyLines.push(this.theme.fg("dim", ` ${this.selected + 1}/${this.sessions.length}`));
      }
    }

    const paddedBody = bodyLines.map((line) => padRight(truncateToWidth(line, inner, "…"), inner));
    return [
      topBorderWithTitle(this.theme, this.formatSummary(), inner),
      ...paddedBody.map((line) => this.theme.fg("borderAccent", "│") + line + this.theme.fg("borderAccent", "│")),
      this.theme.fg("borderAccent", `╰${"─".repeat(inner)}╯`),
    ].map((line) => truncateToWidth(line, width, ""));
  }
}
