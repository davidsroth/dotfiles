import type { Component, TUI } from "@mariozechner/pi-tui";
import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { IntercomClient } from "../broker/client.js";
import type { SessionInfo } from "../types.js";
import { framedOverlay, hintLine } from "./frame.js";
import { cwdLabel } from "./text.js";

export interface ComposeResult {
  sent: boolean;
  messageId?: string;
  text?: string;
}

export class ComposeOverlay implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private target: SessionInfo;
  private targetLabel: string;
  private client: IntercomClient;
  private done: (result: ComposeResult) => void;
  private inputBuffer: string = "";
  private sending: boolean = false;
  private error: string | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    target: SessionInfo,
    targetLabel: string,
    client: IntercomClient,
    done: (result: ComposeResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.target = target;
    this.targetLabel = targetLabel;
    this.client = client;
    this.done = done;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.sending) return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done({ sent: false });
      return;
    }

    if (data.startsWith("\x1b")) {
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.inputBuffer.trim()) {
        this.sendMessage();
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.inputBuffer = [...this.inputBuffer].slice(0, -1).join("");
      this.tui.requestRender();
      return;
    }

    const printable = [...data].filter(c => c >= " ").join("");
    if (printable) {
      this.inputBuffer += printable;
      this.tui.requestRender();
    }
  }

  private async sendMessage(): Promise<void> {
    this.sending = true;
    this.error = null;
    this.tui.requestRender();

    try {
      const result = await this.client.send(this.target.id, {
        text: this.inputBuffer.trim(),
      });
      
      if (!result.delivered) {
        this.error = result.reason ?? "Message not delivered. Session may not exist or has disconnected.";
        this.sending = false;
        this.tui.requestRender();
        return;
      }
      
      this.done({
        sent: true,
        messageId: result.id,
        text: this.inputBuffer.trim(),
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.sending = false;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const title = `${this.theme.fg("dim", "Send to:")} ${this.theme.fg("text", this.targetLabel)} ${this.theme.fg("dim", "·")} ${this.theme.fg("muted", `${cwdLabel(this.target.cwd)} · ${this.target.model}`)}`;
    const bodyLines: string[] = [
      hintLine(this.theme, ["enter: send", "esc: cancel"]),
      "",
    ];

    if (this.sending) {
      bodyLines.push(this.theme.fg("dim", " Sending…"));
    } else {
      if (this.error) {
        bodyLines.push(this.theme.fg("error", ` ⚠ ${this.error}`));
        bodyLines.push("");
      }
      bodyLines.push(` ${this.theme.fg("accent", "›")} ${this.inputBuffer}█`);
    }

    bodyLines.push("");
    return framedOverlay(this.theme, title, bodyLines, width);
  }
}
