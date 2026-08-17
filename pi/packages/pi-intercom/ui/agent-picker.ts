import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeyId, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { sameCwd } from "../cwd.ts";
import { formatContextUsage } from "../format-context.ts";
import type { SessionInfo } from "../types.ts";
import {
  activityState,
  cwdLabel,
  formatAge,
  middleTruncate,
  shortSessionId,
  sortSessionsForPicker,
} from "./agent-picker-util.ts";
import { activityMarker, framedPicker } from "./agent-picker-frame.ts";

function sessionName(session: SessionInfo): string {
  return session.name || "Unnamed session";
}

export class AgentPickerOverlay implements Component {
  private selected = 0;
  private scrollTop = 0;
  private readonly maxVisiblePeers = 10;
  private currentSession: SessionInfo;
  private sessions: SessionInfo[];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    currentSession: SessionInfo,
    sessions: SessionInfo[],
    private readonly closeKey: KeyId,
    private readonly done: (result: SessionInfo | undefined) => void,
  ) {
    this.currentSession = currentSession;
    this.sessions = sortSessionsForPicker(sessions);
  }

  invalidate(): void {}

  private peers(): SessionInfo[] {
    return this.sessions.filter((session) => session.id !== this.currentSession.id);
  }

  /** Replace the live broker snapshot while retaining the selected peer by stable id. */
  setSessions(sessions: SessionInfo[]): void {
    const previousPeers = this.peers();
    const selectedId = previousPeers[this.selected]?.id;
    const previousIndex = this.selected;
    const self = sessions.find((session) => session.id === this.currentSession.id);
    if (self) this.currentSession = self;
    this.sessions = sortSessionsForPicker(sessions);

    const nextPeers = this.peers();
    const selectedIndex = selectedId ? nextPeers.findIndex((session) => session.id === selectedId) : -1;
    this.selected = selectedIndex >= 0
      ? selectedIndex
      : Math.min(previousIndex, Math.max(0, nextPeers.length - 1));
    this.tui.requestRender();
  }

  private move(delta: number): void {
    const count = this.peers().length;
    if (count === 0) return;
    this.selected = (this.selected + delta + count) % count;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, this.closeKey)
      || matchesKey(data, Key.escape)
      || matchesKey(data, Key.ctrl("c"))
      || data === "q"
      || this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.done(undefined);
      return;
    }

    const peers = this.peers();
    if (peers.length === 0) return;

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
      this.tui.requestRender();
      return;
    }
    if (data === "G") {
      this.selected = peers.length - 1;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || this.keybindings.matches(data, "tui.select.confirm")) {
      const peer = peers[this.selected];
      if (peer) this.done(peer);
    }
  }

  private formatSummary(): string {
    const now = Date.now();
    const active = this.sessions.filter((session) => activityState(session, now) === "active").length;
    const stale = this.sessions.filter((session) => activityState(session, now) === "stale").length;
    const idle = this.sessions.length - active - stale;
    const staleText = stale ? ` · ${stale} stale` : "";
    return `Agents: ${this.sessions.length} connected · ${active} active · ${idle} idle${staleText}`;
  }

  private formatRow(session: SessionInfo, selected: boolean, width: number, self: boolean): string {
    const activity = activityState(session);
    const pointer = selected ? this.theme.fg("accent", "▸") : " ";
    const titleText = `${sessionName(session)} (${shortSessionId(session.id)})`;
    const title = selected ? this.theme.bold(this.theme.fg("text", titleText)) : this.theme.fg("text", titleText);
    const tags = [
      self ? "self" : undefined,
      !self && sameCwd(session.cwd, this.currentSession.cwd) ? "same cwd" : undefined,
    ].filter((tag): tag is string => Boolean(tag));
    const tagText = tags.length ? this.theme.fg("dim", ` [${tags.join(", ")}]`) : "";
    const status = activity === "active"
      ? this.theme.fg("accent", session.status || "active")
      : this.theme.fg("muted", activity === "stale" ? `stale ${session.status || "active"}` : "idle");
    const context = formatContextUsage(session);
    const model = this.theme.fg("muted", `${session.model}${context}`);
    const trust = !self && session.trustedLocal !== true
      ? `${this.theme.fg("dim", " · ")}${this.theme.fg("warning", "unverified")}`
      : "";
    const project = cwdLabel(session.cwd);
    const pathBudget = Math.max(10, Math.min(30, Math.floor(width / 4)));
    const path = `${project} (${middleTruncate(session.cwd, pathBudget)})`;
    const age = activity === "stale" ? ` · ${formatAge(session.lastActivity)}` : "";

    return `${pointer} ${activityMarker(this.theme, activity)} ${title}${tagText} ${this.theme.fg("dim", "·")} ${status} ${this.theme.fg("dim", "·")} ${model}${trust} ${this.theme.fg("dim", "·")} ${this.theme.fg("dim", path + age)}`;
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const peers = this.peers();
    const body: string[] = [
      this.theme.fg("dim", " enter: switch · j/k: move · g/G: ends · q/esc: close"),
      this.theme.fg("dim", " Self"),
      this.formatRow(this.currentSession, false, contentWidth, true),
      this.theme.fg("dim", " Peers"),
    ];

    if (peers.length === 0) {
      body.push(this.theme.fg("muted", "  No other intercom-connected Pi sessions"));
    } else {
      this.selected = Math.max(0, Math.min(this.selected, peers.length - 1));
      const visibleCount = Math.min(this.maxVisiblePeers, peers.length);
      if (this.selected < this.scrollTop) this.scrollTop = this.selected;
      if (this.selected >= this.scrollTop + visibleCount) this.scrollTop = this.selected - visibleCount + 1;
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, peers.length - visibleCount));

      peers.slice(this.scrollTop, this.scrollTop + visibleCount).forEach((session, index) => {
        body.push(this.formatRow(session, this.scrollTop + index === this.selected, contentWidth, false));
      });
      if (visibleCount < peers.length) {
        body.push(this.theme.fg("dim", ` ${this.selected + 1}/${peers.length} peers`));
      }
    }

    return framedPicker(this.theme, this.formatSummary(), body, width);
  }
}
