import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { SessionInfo } from "../types.js";
import { activityState, formatAge } from "./agent-picker-util.js";
import { activityMarker, framedOverlay, hintLine, innerWidth } from "./frame.js";
import { cwdLabel, middleTruncate, shortSessionId } from "./text.js";

function sessionName(session: SessionInfo): string {
  return session.name || "Unnamed session";
}

/**
 * Recipient picker for the `/intercom` (Alt+M) compose flow. Renders the same
 * subtle bordered card and activity language as the agent picker: a single
 * list of every connected session (yours tagged `self`), navigable with vim
 * keys, with `Enter` choosing the message target. Selecting `self` is a no-op
 * (you can't message yourself), matching the agent picker's behavior.
 */
export class SessionListOverlay implements Component {
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private currentSession: SessionInfo;
  private sessions: SessionInfo[];
  private done: (result: SessionInfo | undefined) => void;
  private selected = 0;
  private scrollTop = 0;
  private maxVisibleRows = 12;

  constructor(
    theme: Theme,
    keybindings: KeybindingsManager,
    currentSession: SessionInfo,
    sessions: SessionInfo[],
    done: (result: SessionInfo | undefined) => void,
  ) {
    this.theme = theme;
    this.keybindings = keybindings;
    this.currentSession = currentSession;
    this.sessions = sessions;
    this.done = done;
  }

  invalidate(): void {}

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
      matchesKey(data, Key.escape)
      || matchesKey(data, Key.ctrl("c"))
      || data === "q"
      || this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.done(undefined);
      return;
    }

    if (this.sessions.length === 0) return;

    if (
      matchesKey(data, Key.shift(Key.tab))
      || matchesKey(data, Key.up)
      || data === "k"
      || this.keybindings.matches(data, "tui.select.up")
    ) {
      this.move(-1);
      return;
    }

    if (
      matchesKey(data, Key.tab)
      || matchesKey(data, Key.down)
      || data === "j"
      || this.keybindings.matches(data, "tui.select.down")
    ) {
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
      // The `self` row is shown for context but isn't a message target; ignore
      // Enter on it (you can't message yourself).
      if (session && session.id !== this.currentSession.id) this.done(session);
    }
  }

  private formatSummary(): string {
    const now = Date.now();
    const active = this.sessions.filter((session) => activityState(session, now) === "active").length;
    return `${this.theme.fg("dim", "Send to:")} ${this.theme.fg("accent", String(this.sessions.length))} ${this.theme.fg("muted", "connected")} ${this.theme.fg("dim", "·")} ${this.theme.fg("accent", String(active))} ${this.theme.fg("muted", "active")}`;
  }

  private formatRow(session: SessionInfo, isSelected: boolean, inner: number): string {
    const stateKind = activityState(session);
    const statusText = session.status || "idle";
    const isSelf = session.id === this.currentSession.id;
    const pointer = isSelected ? this.theme.fg("accent", "▸") : " ";
    const marker = activityMarker(this.theme, stateKind);
    const state = stateKind === "active"
      ? this.theme.fg("accent", statusText)
      : this.theme.fg("muted", stateKind === "stale" ? `stale ${statusText}` : "idle");
    const tags = [
      isSelf ? "self" : undefined,
      !isSelf && session.cwd === this.currentSession.cwd ? "same cwd" : undefined,
    ].filter((tag): tag is string => Boolean(tag));
    const tagLabel = tags.length ? this.theme.fg("dim", ` [${tags.join(", ")}]`) : "";
    const titleText = `${sessionName(session)} (${shortSessionId(session.id)})`;
    const title = isSelected ? this.theme.bold(this.theme.fg("text", titleText)) : this.theme.fg("text", titleText);
    const project = this.theme.fg("muted", cwdLabel(session.cwd));
    const status = stateKind === "stale"
      ? `${this.theme.fg("dim", " · ")}${this.theme.fg("muted", `last update ${formatAge(session.lastActivity)}`)}`
      : "";
    const model = `${this.theme.fg("dim", " · ")}${this.theme.fg("muted", session.model)}`;
    const cwdBudget = Math.max(10, Math.min(32, Math.floor(inner / 4)));
    const path = this.theme.fg("dim", ` (${middleTruncate(session.cwd, cwdBudget)})`);

    return `${pointer} ${marker} ${state} ${title}${tagLabel} ${this.theme.fg("dim", "·")} ${project}${path}${model}${status}`;
  }

  render(width: number): string[] {
    const inner = innerWidth(width);
    const bodyLines: string[] = [
      hintLine(this.theme, ["enter: compose", "j/k: move", "g/G: ends", "esc: cancel"]),
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

    return framedOverlay(this.theme, this.formatSummary(), bodyLines, width);
  }
}
