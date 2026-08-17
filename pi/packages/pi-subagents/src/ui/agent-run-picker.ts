import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import type { AgentActivity, Theme } from "./agent-widget.js";
import { renderAgentRunLine } from "./agent-widget.js";

export interface AgentRunPickerSource {
  getAgents(): AgentRecord[];
  getActivity(agentId: string): AgentActivity | undefined;
}

/** Runs that still have work pending and belong in the focused active-agent UI. */
export function isActiveAgentRecord(record: AgentRecord): boolean {
  return record.status === "running" || record.status === "queued";
}

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Live, widget-style picker for active (running or queued) agents. */
export class AgentRunPicker implements Component {
  private selectedId: string | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private tui: TUI,
    private source: AgentRunPickerSource,
    private theme: Theme,
    private done: (agentId: string | undefined) => void,
    initialAgentId?: string,
  ) {
    this.selectedId = initialAgentId;
    this.syncSelection();
    this.interval = setInterval(() => {
      if (this.closed) return;
      if (this.source.getAgents().length === 0) {
        this.close(undefined);
        return;
      }
      this.tui.requestRender();
    }, 100);
    this.interval.unref?.();
  }

  handleInput(data: string): void {
    const agents = this.source.getAgents();
    this.syncSelection(agents);

    if (matchesKey(data, "escape") || matchesKey(data, "right") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      this.close(undefined);
      return;
    }

    if (agents.length === 0) return;
    const current = Math.max(0, agents.findIndex((agent) => agent.id === this.selectedId));

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.selectedId = agents[(current - 1 + agents.length) % agents.length]?.id;
      this.tui.requestRender();
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.selectedId = agents[(current + 1) % agents.length]?.id;
      this.tui.requestRender();
    } else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      this.close(this.selectedId);
    }
  }

  render(width: number): string[] {
    if (width < 6) return [];
    const agents = this.source.getAgents();
    this.syncSelection(agents);

    const innerWidth = Math.max(1, width - 2);
    const bodyWidth = Math.max(1, innerWidth - 2);
    const side = this.theme.fg("borderMuted", "│");
    const row = (content: string) => `${side} ${padToWidth(content, bodyWidth)} ${side}`;
    const heading = truncateToWidth(`─agents (${agents.length}) `, Math.max(1, width - 2), "");
    const top = this.theme.fg(
      "borderMuted",
      `╭${heading}${"─".repeat(Math.max(0, width - visibleWidth(heading) - 2))}╮`,
    );
    const bottom = this.theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`);

    const focusedHeight = Math.max(4, Math.floor(this.tui.terminal.rows * 0.7));
    const showOverflowIndicators = focusedHeight >= 6;
    // Reserve top + hint + bottom, plus up to two overflow indicators when space permits.
    const maxVisible = Math.max(1, Math.min(10, focusedHeight - (showOverflowIndicators ? 5 : 3)));
    let visible = agents;
    let hiddenAbove = 0;
    let hiddenBelow = 0;
    if (agents.length > maxVisible) {
      const selectedIndex = Math.max(0, agents.findIndex((agent) => agent.id === this.selectedId));
      const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), agents.length - maxVisible));
      visible = agents.slice(start, start + maxVisible);
      hiddenAbove = start;
      hiddenBelow = agents.length - start - visible.length;
    }

    const lines: string[] = [top];
    if (agents.length === 0) {
      lines.push(row(this.theme.fg("dim", "No active subagents.")));
    } else {
      if (showOverflowIndicators && hiddenAbove > 0) lines.push(row(this.theme.fg("dim", `↑ ${hiddenAbove} more`)));
      for (const agent of visible) {
        lines.push(row(renderAgentRunLine(
          agent,
          this.source.getActivity(agent.id),
          this.theme,
          bodyWidth,
          agent.id === this.selectedId,
        )));
      }
      if (showOverflowIndicators && hiddenBelow > 0) lines.push(row(this.theme.fg("dim", `↓ ${hiddenBelow} more`)));
    }

    lines.push(row(this.theme.fg("dim", "↑↓/jk move · Enter watch · →/Esc back")));
    lines.push(bottom);
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}

  dispose(): void {
    if (!this.closed) this.close(undefined);
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private syncSelection(agents = this.source.getAgents()): void {
    if (agents.some((agent) => agent.id === this.selectedId)) return;
    this.selectedId = agents[0]?.id;
  }

  private close(agentId: string | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.done(agentId);
  }
}
