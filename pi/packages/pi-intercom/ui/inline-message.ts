import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { SessionInfo, Message } from "../types.js";
import { framedOverlay, innerWidth } from "./frame.js";
import { cwdLabel, shortSessionId } from "./text.js";

/**
 * Inline card rendered in the timeline when a message arrives. Shares the
 * intercom frame chrome (subtle `borderAccent` rounded box, title baked into
 * the top edge) with the agent/recipient pickers so incoming messages read as
 * part of the same family.
 */
export class InlineMessageComponent implements Component {
  private from: SessionInfo;
  private message: Message;
  private theme: Theme;
  private replyCommand?: string;
  private bodyText?: string;

  constructor(from: SessionInfo, message: Message, theme: Theme, replyCommand?: string, bodyText?: string) {
    this.from = from;
    this.message = message;
    this.theme = theme;
    this.replyCommand = replyCommand;
    this.bodyText = bodyText;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const senderName = this.from.name || shortSessionId(this.from.id);
    if (width < 3) {
      return [truncateToWidth(`From ${senderName}`, width)];
    }

    const inner = innerWidth(width);
    const textWidth = Math.max(1, inner - 1);
    const title = `${this.theme.fg("accent", "📨")} ${this.theme.fg("text", `${senderName} (${shortSessionId(this.from.id)})`)} ${this.theme.fg("dim", "·")} ${this.theme.fg("muted", cwdLabel(this.from.cwd))}`;

    const bodyLines: string[] = [];
    for (const line of wrapTextWithAnsi(this.bodyText || this.message.content.text, textWidth)) {
      bodyLines.push(` ${line}`);
    }

    if (this.replyCommand) {
      bodyLines.push("");
      for (const line of wrapTextWithAnsi(this.theme.fg("dim", `↩ reply: ${this.replyCommand}`), textWidth)) {
        bodyLines.push(` ${line}`);
      }
    }

    if (this.message.content.attachments?.length) {
      bodyLines.push("");
      for (const att of this.message.content.attachments) {
        bodyLines.push(` ${this.theme.fg("dim", `📎 ${att.name}`)}`);
      }
    }

    if (this.message.replyTo && !this.message.expectsReply) {
      bodyLines.push("");
      bodyLines.push(` ${this.theme.fg("dim", `↳ reply to ${shortSessionId(this.message.replyTo)}`)}`);
    }

    return framedOverlay(this.theme, title, bodyLines, width);
  }
}
