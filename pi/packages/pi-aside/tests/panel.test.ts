import { expect, it, vi } from "vitest";
import { CustomEditor, getSelectListTheme, initTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, TuiAltScreen, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { AsidePanel } from "../src/panel";

it.each(["regular", "fullscreen"])("routes real %s TUI input/focus without replacing the main editor", (mode) => {
  initTheme("dark", false);
  let key!: (data: string) => void;
  const terminal: Terminal = {
    columns: 80, rows: 30, kittyProtocolActive: true,
    start: (onInput) => { key = onInput; }, stop() {}, drainInput: async () => {},
    write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  const editor = new CustomEditor(tui, {
    borderColor: (text) => text, selectList: getSelectListTheme(),
  }, { matches: () => false, getKeys: () => [] } as unknown as KeybindingsManager);
  editor.onSubmit = vi.fn();
  editor.addToHistory("prior main prompt");
  tui.addChild(editor);
  tui.setFocus(editor);
  const submit = vi.fn();
  const disposed = vi.fn();
  const panel = new AsidePanel(tui, { fg: (_color, text) => text } as Theme, "initial", submit, disposed);
  tui.children.unshift(panel);
  const unsubscribe = tui.addInputListener((data) => panel.onTerminalInput(data));
  tui.start();
  try {
    key("\x1b[A");
    expect(tui.getFocusedComponent()).toBe(panel);
    expect(editor.getText()).toBe(""); // Didn't recall main history.
    expect(editor.focused).toBe(false);
    expect(panel.focused).toBe(true);
    expect([...panel.render(80), ...editor.render(80)].join("\n").split(CURSOR_MARKER)).toHaveLength(2);
    key("follow-up");
    key("\r");
    expect(submit).toHaveBeenCalledWith("follow-up");
    expect(editor.onSubmit).not.toHaveBeenCalled();
    key("draft");
    key("\x1b[B");
    expect(tui.getFocusedComponent()).toBe(editor);
    key("main draft");
    key("\x1b[A");
    expect(tui.getFocusedComponent()).toBe(editor);
    expect(editor.getText()).toBe("main draft");
    editor.setText("");
    key("\x1b[A");
    expect(panel.render(80).join("\n")).toContain("draft");
    const dialog = { render: () => ["dialog"], invalidate() {}, handleInput: vi.fn() };
    // Inline ctx.ui dialogs restore the main editor rather than previous focus.
    tui.setFocus(dialog);
    key("\x1b[A");
    expect(dialog.handleInput).toHaveBeenCalledOnce();
    tui.setFocus(editor);
    key("\x1b[A");
    expect(tui.getFocusedComponent()).toBe(panel);
    expect(panel.render(80).join("\n")).toContain("draft");
    dialog.handleInput.mockClear();
    const overlay = tui.showOverlay(dialog);
    key("\x1b[A");
    expect(dialog.handleInput).toHaveBeenCalledOnce();
    expect(tui.getFocusedComponent()).toBe(dialog);
    overlay.hide();
    expect(tui.getFocusedComponent()).toBe(panel);
    // An overlay can retain a panel reference after /aside clear removes it.
    const survivingOverlay = tui.showOverlay(dialog);
    panel.dispose();
    expect(tui.getFocusedComponent()).toBe(dialog);
    tui.removeChild(panel);
    survivingOverlay.hide();
    expect(tui.getFocusedComponent()).toBe(editor);
    key("main after dismissal");
    expect(editor.getText()).toBe("main after dismissal");
    expect(disposed).toHaveBeenCalledOnce();
    panel.dispose();
    expect(disposed).toHaveBeenCalledOnce();
  } finally {
    unsubscribe();
    panel.dispose();
    tui.stop();
  }
});
