import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Input, Markdown, isKeyRelease, matchesKey, truncateToWidth, visibleWidth,
  type Component, type Focusable, type TUI,
} from "@earendil-works/pi-tui";
import type { AsideUpdate } from "./side-session";

// Both Pi renderers expose this public TuiBase method, although the common
// TUI interface omits it. Fail closed if a future renderer lacks focus access.
type FocusTUI = TUI & { getFocusedComponent?: () => Component | null };
type MainEditor = Component & { getText(): string; setText(text: string): void };

function isEditor(component: Component | null): component is MainEditor {
  return !!component && "getText" in component && typeof component.getText === "function"
    && "setText" in component && typeof component.setText === "function";
}

/** An inline widget with its own input, not a replacement for Pi's editor. */
export class AsidePanel implements Component, Focusable {
  private readonly input = new Input({ prompt: "> ", placeholder: "Ask a follow-up…" });
  private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());
  private readonly mainEditor: MainEditor | undefined;
  private editing = false;
  private disposed = false;
  private state: AsideUpdate = { text: "", status: "Thinking…" };
  private error = false;
  private pending = 1;

  constructor(
    private readonly tui: FocusTUI,
    private readonly theme: Theme,
    private question: string,
    private readonly submit: (question: string) => void,
    private readonly onDispose: () => void,
  ) {
    const focused = tui.getFocusedComponent?.() ?? null;
    this.mainEditor = isEditor(focused) ? focused : undefined;
    this.input.onEscape = () => this.closeInput();
    this.input.onSubmit = (value) => {
      const question = value.trim();
      if (!question || this.disposed) return;
      this.input.setValue("");
      this.submit(question);
      this.tui.requestRender();
    };
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) {
    this.input.focused = value && !this.disposed;
    // Overlays retain their previous focus target. If one outlives this widget,
    // redirect its eventual restoration without disturbing it while still open.
    if (value && this.disposed && this.tui.getFocusedComponent?.() === this) {
      this.tui.setFocus(this.mainEditor ?? null);
      this.tui.requestRender();
    }
  }

  /** Called by ctx.ui.onTerminalInput; never claim keys owned by other UI. */
  onTerminalInput(data: string): { consume: true } | undefined {
    if (this.disposed || isKeyRelease(data) || !matchesKey(data, "up")) return;
    if (!this.mainEditor || this.tui.hasOverlay()
      || this.tui.getFocusedComponent?.() !== this.mainEditor
      || this.mainEditor.getText() !== "") return;
    this.editing = true;
    this.tui.setFocus(this);
    this.tui.requestRender();
    return { consume: true };
  }

  handleInput(data: string): void {
    if (this.disposed || !this.editing) return;
    if (matchesKey(data, "down")) this.closeInput();
    else this.input.handleInput(data);
    this.tui.requestRender();
  }

  private closeInput(): void {
    this.editing = false;
    // A dialog may have taken focus meanwhile; don't steal it back on cleanup.
    if (this.tui.getFocusedComponent?.() === this) this.tui.setFocus(this.mainEditor ?? null);
    this.tui.requestRender();
  }

  update(question: string, state: AsideUpdate, error = false): void {
    if (this.disposed) return;
    this.question = question;
    this.state = state;
    this.error = error;
    this.markdown.setText(state.text);
    this.tui.requestRender();
  }

  setPending(count: number): void {
    this.pending = count;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 1 || this.disposed) return [];
    const queued = Math.max(0, this.pending - 1);
    const hint = this.editing ? "Esc/↓ back" : "↑ reply (empty prompt)";
    const status = `${this.state.status.replace(/\s+/g, " ")}${queued ? ` · ${queued} queued` : ""} · ${hint} · /aside clear`;
    return [
      truncateToWidth(this.theme.fg("accent", `Aside · ${this.question.replace(/\s+/g, " ")}`), width),
      ...this.markdown.render(width).map((line) => truncateToWidth(line, width)),
      truncateToWidth(this.theme.fg(this.error ? "error" : "dim", status), width),
      ...(this.editing ? this.renderInput(width) : []),
    ];
  }

  private renderInput(width: number): string[] {
    if (width < 5) return this.input.render(width).map((line) => truncateToWidth(line, width));
    const inner = width - 4;
    const label = truncateToWidth(" Reply to aside · Enter send ", inner, "");
    return [
      this.theme.fg("dim", `  ┌${label}${"─".repeat(inner - visibleWidth(label))}┐`),
      ...this.input.render(inner).map((line) => `  ${this.theme.fg("dim", "│")}${line}${this.theme.fg("dim", "│")}`),
      this.theme.fg("dim", `  └${"─".repeat(inner)}┘`),
    ];
  }

  invalidate(): void {
    this.markdown.invalidate();
    this.input.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeInput();
    this.onDispose();
  }
}
