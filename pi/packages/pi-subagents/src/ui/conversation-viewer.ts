/**
 * conversation-viewer.ts — Widget-style live monitor for subagent sessions.
 *
 * Shows one active agent conversation at a time, supports direct navigation
 * between running/queued agents, and provides inline steering for running agents.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { extractText } from "../context.js";
import type { AgentRecord } from "../types.js";
import { formatCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import {
  type AgentActivity,
  buildInvocationTags,
  describeActivity,
  formatDuration,
  formatTokens,
  getDisplayName,
  getPromptModeLabel,
} from "./agent-widget.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling for the focused widget's conversation viewport. */
const MONITOR_HEIGHT_PCT = 70;

export interface ConversationViewerOptions {
  /** Live active-run list, in display order. Enables previous/next navigation. */
  getAgents?: () => AgentRecord[];
  /** Live activity lookup for records returned by getAgents. */
  getActivity?: (agentId: string) => AgentActivity | undefined;
  /** Send a user-authored steering message to the selected record. */
  onSteer?: (record: AgentRecord, message: string) => Promise<{ ok: boolean; message: string }>;
}

export class ConversationViewer implements Component, Focusable {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private lastInnerW = 0;
  private closed = false;
  private composingSteer = false;
  private sendingSteer = false;
  private steerStatus: string | undefined;
  private steerStatusIsError = false;
  private steerInput = new Input();
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.steerInput.focused = value && this.composingSteer;
  }

  constructor(
    private tui: TUI,
    private session: AgentSession | undefined,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (selectedAgentId: string | undefined) => void,
    private options: ConversationViewerOptions = {},
  ) {
    this.attachSession(session);
    this.steerInput.onSubmit = (value) => {
      void this.submitSteer(value);
    };
    this.steerInput.onEscape = () => this.cancelSteer();
    this.interval = setInterval(() => {
      if (this.closed) return;
      if (this.options.getAgents && this.options.getAgents().length === 0) {
        this.closed = true;
        this.done(undefined);
        return;
      }
      this.tui.requestRender();
    }, 100);
    this.interval.unref?.();
  }

  handleInput(data: string): void {
    this.syncRecord();

    if (this.composingSteer) {
      this.steerInput.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      this.closed = true;
      this.done(this.record.id);
      return;
    }

    if (matchesKey(data, "left") || matchesKey(data, "h")) {
      this.moveAgent(-1);
      return;
    }
    if (matchesKey(data, "right") || matchesKey(data, "l")) {
      this.moveAgent(1);
      return;
    }
    if (matchesKey(data, "s")) {
      if (this.record.status !== "running") {
        this.setSteerStatus(`Cannot steer a ${this.record.status} agent.`, true);
      } else if (!this.options.onSteer) {
        this.setSteerStatus("Steering is unavailable in this view.", true);
      } else {
        this.composingSteer = true;
        this.steerStatus = undefined;
        this.steerInput.setValue("");
        this.steerInput.focused = this.focused;
        this.tui.requestRender();
      }
      return;
    }

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 6) return [];
    this.syncRecord();

    const th = this.theme;
    const innerW = width - 4;
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (text: string, len: number) => {
      const clipped = truncateToWidth(text, len, "");
      return clipped + " ".repeat(Math.max(0, len - visibleWidth(clipped)));
    };
    const row = (content: string) =>
      th.fg("borderMuted", "│") + " " + pad(content, innerW) + " " + th.fg("borderMuted", "│");

    const agents = this.getAgents();
    const selectedIndex = Math.max(0, agents.findIndex((agent) => agent.id === this.record.id));
    const rawTitle = `─agents · ${getDisplayName(this.record.type)} · ${selectedIndex + 1}/${Math.max(1, agents.length)} `;
    const title = truncateToWidth(rawTitle, Math.max(1, width - 2), "");
    const titleWidth = visibleWidth(title);
    const hrTop = th.fg("borderMuted", "╭") + th.fg("accent", title) +
      th.fg("borderMuted", `${"─".repeat(Math.max(0, width - titleWidth - 2))}╮`);
    const hrBot = th.fg("borderMuted", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("borderMuted", "─".repeat(innerW)));

    lines.push(hrTop);
    const name = getDisplayName(this.record.type);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "queued"
        ? th.fg("muted", "◦")
        : this.record.status === "completed"
          ? th.fg("success", "✓")
          : this.record.status === "error"
            ? th.fg("error", "✗")
            : th.fg("dim", "■");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const statPieces: string[] = [];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) statPieces.push(th.fg("dim", `${toolUses} tool${toolUses === 1 ? "" : "s"}`));

    const tokens = this.activity
      ? getLifetimeTotal(this.activity.lifetimeUsage)
      : getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) {
      const tokenStr = formatTokens(tokens);
      const percent = getSessionContextPercent(this.activity?.session ?? this.session);
      const hasAnnot = percent !== null || this.record.compactionCount > 0;
      if (hasAnnot) {
        const annotInner: string[] = [];
        if (percent !== null) {
          const level = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
          annotInner.push(th.fg(level, `${Math.round(percent)}%`));
        }
        if (this.record.compactionCount > 0) {
          annotInner.push(th.fg("dim", `↻${this.record.compactionCount}`));
        }
        statPieces.push(th.fg("dim", `${tokenStr} (`) + annotInner.join(th.fg("dim", " · ")) + th.fg("dim", ")"));
      } else {
        statPieces.push(th.fg("dim", tokenStr));
      }
    }

    const cost = this.activity?.lifetimeUsage?.cost ?? this.record.lifetimeUsage?.cost ?? 0;
    if (cost > 0) statPieces.push(th.fg("dim", formatCost(cost)));
    statPieces.push(th.fg("dim", duration));
    const statsLine = statPieces.join(th.fg("dim", " · "));

    lines.push(row(
      `${statusIcon} ${th.bold(name)}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${statsLine}`,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) this.scrollOffset = maxScroll;

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
    for (let i = 0; i < viewportHeight; i++) lines.push(row(visible[i] ?? ""));

    lines.push(hrMid);
    if (this.composingSteer) {
      this.steerInput.focused = this.focused;
      const errorPrefix = this.steerStatusIsError && this.steerStatus
        ? th.fg("error", `${this.steerStatus} · `)
        : "";
      const prompt = errorPrefix + th.fg("accent", "steer ");
      const inputWidth = Math.max(1, innerW - visibleWidth(prompt));
      const inputLine = this.steerInput.render(inputWidth)[0] ?? "";
      lines.push(row(prompt + inputLine));
    } else {
      const scrollPct = contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
      const status = this.steerStatus
        ? th.fg(this.steerStatusIsError ? "error" : "success", this.steerStatus)
        : th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
      const hint = this.record.status === "running"
        ? "←→/hl agent · PgUp/PgDn scroll · s steer · Esc picker"
        : "←→/hl agent · PgUp/PgDn scroll · Esc picker";
      const footerRight = th.fg("dim", hint);
      const footerGap = Math.max(1, innerW - visibleWidth(status) - visibleWidth(footerRight));
      lines.push(row(status + " ".repeat(footerGap) + footerRight));
    }
    lines.push(hrBot);

    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {
    this.steerInput.invalidate();
  }

  dispose(): void {
    if (!this.closed) {
      this.closed = true;
      this.done(undefined);
    }
    this.detachSession();
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private getAgents(): AgentRecord[] {
    return this.options.getAgents ? this.options.getAgents() : [this.record];
  }

  private syncRecord(): void {
    const agents = this.getAgents();
    if (agents.length === 0) {
      this.activity = undefined;
      this.attachSession(undefined);
      return;
    }

    const live = agents.find((agent) => agent.id === this.record.id) ?? agents[0];
    if (live && live !== this.record) this.selectRecord(live);
    if (this.record.session !== this.session) this.attachSession(this.record.session);
    if (this.options.getActivity) this.activity = this.options.getActivity(this.record.id);
  }

  private moveAgent(delta: -1 | 1): void {
    const agents = this.getAgents();
    if (agents.length < 2) return;
    const index = Math.max(0, agents.findIndex((agent) => agent.id === this.record.id));
    const next = agents[(index + delta + agents.length) % agents.length];
    if (!next) return;
    this.selectRecord(next);
    this.tui.requestRender();
  }

  private selectRecord(record: AgentRecord): void {
    this.record = record;
    this.activity = this.options.getActivity?.(record.id);
    this.attachSession(record.session);
    this.scrollOffset = 0;
    this.autoScroll = true;
    this.composingSteer = false;
    this.steerInput.setValue("");
    this.steerStatus = undefined;
  }

  private attachSession(session: AgentSession | undefined): void {
    if (session === this.session && this.unsubscribe) return;
    this.detachSession();
    this.session = session;
    if (!session) return;
    this.unsubscribe = session.subscribe(() => {
      if (!this.closed) this.tui.requestRender();
    });
  }

  private detachSession(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private cancelSteer(): void {
    if (this.sendingSteer) return;
    this.composingSteer = false;
    this.steerInput.setValue("");
    this.steerInput.focused = false;
    this.tui.requestRender();
  }

  private async submitSteer(rawMessage: string): Promise<void> {
    const message = rawMessage.trim();
    if (!message || this.sendingSteer || !this.options.onSteer) return;

    const target = this.record;
    this.sendingSteer = true;
    this.steerStatus = "Sending steering message…";
    this.steerStatusIsError = false;
    this.tui.requestRender();
    try {
      const result = await this.options.onSteer(target, message);
      if (this.closed || this.record.id !== target.id) return;
      if (result.ok) {
        this.composingSteer = false;
        this.steerInput.setValue("");
        this.steerInput.focused = false;
      }
      this.setSteerStatus(result.message, !result.ok);
    } catch (error) {
      if (this.closed || this.record.id !== target.id) return;
      this.setSteerStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.sendingSteer = false;
      if (!this.closed) this.tui.requestRender();
    }
  }

  private setSteerStatus(message: string, isError: boolean): void {
    this.steerStatus = message;
    this.steerStatusIsError = isError;
    this.tui.requestRender();
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal.rows;
    const heightPercent = rows < 14 ? 100 : MONITOR_HEIGHT_PCT;
    const maxRows = Math.floor((rows * heightPercent) / 100);
    return Math.max(rows < 14 ? 0 : MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    if (this.tui.terminal.rows < 8) return undefined;
    const { modelName, tags } = buildInvocationTags(this.record.invocation);
    const parts = modelName ? [modelName, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const messages = this.session?.messages ?? [];
    const lines: string[] = [];

    if (messages.length === 0) {
      const empty = this.record.status === "queued"
        ? "Waiting for an execution slot…"
        : this.record.status === "running"
          ? "Waiting for the first message…"
          : "No retained conversation for this agent."
      lines.push(th.fg("dim", empty));
      return lines;
    }

    let needsSeparator = false;
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
        if (!text.trim()) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("accent", "[User]"));
        for (const line of wrapTextWithAnsi(text.trim(), width)) lines.push(line);
      } else if (msg.role === "assistant") {
        const textParts: string[] = [];
        const toolCalls: string[] = [];
        for (const content of msg.content) {
          if (content.type === "text" && content.text) textParts.push(content.text);
          else if (content.type === "toolCall") {
            toolCalls.push((content as any).name ?? (content as any).toolName ?? "unknown");
          }
        }
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.bold("[Assistant]"));
        if (textParts.length > 0) {
          for (const line of wrapTextWithAnsi(textParts.join("\n").trim(), width)) lines.push(line);
        }
        for (const name of toolCalls) {
          lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width));
        }
      } else if (msg.role === "toolResult") {
        const text = extractText(msg.content);
        const truncated = text.length > 500 ? text.slice(0, 500) + "... (truncated)" : text;
        if (!truncated.trim()) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("dim", "[Result]"));
        for (const line of wrapTextWithAnsi(truncated.trim(), width)) lines.push(th.fg("dim", line));
      } else if ((msg as any).role === "bashExecution") {
        const bash = msg as any;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width));
        if (bash.output?.trim()) {
          const output = bash.output.length > 500 ? bash.output.slice(0, 500) + "... (truncated)" : bash.output;
          for (const line of wrapTextWithAnsi(output.trim(), width)) lines.push(th.fg("dim", line));
        }
      } else {
        continue;
      }
      needsSeparator = true;
    }

    if (this.record.status === "running" && this.activity) {
      const currentActivity = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", currentActivity), width));
    }

    return lines.map((line) => truncateToWidth(line, width));
  }
}
