import { beforeEach, expect, it, vi } from "vitest";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import aside from "../src/index";
import { createAsideThread } from "../src/side-session";

vi.mock("../src/side-session", () => ({ createAsideThread: vi.fn() }));
const create = vi.mocked(createAsideThread);
const threads: { ask: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] = [];

function harness(mode = "tui") {
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  let component: any;
  let listener: ((data: string) => any) | undefined;
  let editorText = "";
  const main = { focused: true, getText: () => editorText, setText: (text: string) => { editorText = text; } };
  let focus: any = main;
  let overlay = false;
  const repaint = vi.fn();
  const unsubscribe = vi.fn(() => { listener = undefined; });
  const tui = {
    requestRender: repaint,
    getFocusedComponent: () => focus,
    setFocus: (next: any) => { if (focus) focus.focused = false; focus = next; if (focus) focus.focused = true; },
    hasOverlay: () => overlay,
  };
  const ctx = {
    mode, ui: {
      notify: vi.fn(),
      onTerminalInput: vi.fn((fn) => { listener = fn; return unsubscribe; }),
      setWidget: vi.fn((_key, factory, options) => {
        component?.dispose();
        if (factory) expect(options).toEqual({ placement: "aboveEditor" });
        component = factory?.(tui, { fg: (_color: string, text: string) => text });
      }),
    },
  } as unknown as ExtensionCommandContext;
  aside({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    on: (name: string, fn: any) => events.set(name, fn),
  } as unknown as ExtensionAPI);
  return {
    ctx, commands, repaint, main, unsubscribe, tui,
    command: (text: string) => commands.get("aside").handler(text, ctx),
    event: (name: string) => events.get(name)({}, ctx),
    render: (width = 80): string[] => component?.render(width) ?? [],
    invalidate: () => component.invalidate(),
    key: (data: string) => {
      const result = listener?.(data);
      if (!result?.consume) focus?.handleInput?.(data);
      return result;
    },
    setOverlay: (value: boolean) => { overlay = value; },
    disposeWidget: () => component?.dispose(),
  };
}

beforeEach(() => {
  initTheme("dark", false);
  create.mockReset();
  threads.length = 0;
  create.mockImplementation(() => {
    const thread = {
      ask: vi.fn((_question, options) => {
        options.onUpdate({ text: "", status: "Thinking…" });
        return new Promise<string>(() => {});
      }),
      dispose: vi.fn(),
    };
    threads.push(thread);
    return thread;
  });
});

it("registers only /aside, shows usage without calling a model, and requires terminal UI", async () => {
  const h = harness();
  expect([...h.commands.keys()]).toEqual(["aside"]);
  await h.command("");
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "info");
  for (const mode of ["rpc", "print", "json"]) {
    await expect(harness(mode).command("question")).rejects.toThrow("terminal UI");
  }
  expect(create).not.toHaveBeenCalled();
  expect(h.key("\x1b[A")).toBeUndefined();
});

it("returns before the answer finishes and streams a width-safe Markdown panel", async () => {
  const h = harness();
  await h.command("question\nwith emoji 🎉");
  expect(h.render().join("\n")).toContain("Thinking…");
  threads[0].ask.mock.calls[0][1].onUpdate({ text: "**Bold**\n\n- multilingual 中文 🎉\n\n```ts\nconst long = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';\n```", status: "Answering…" });
  for (const width of [1, 2, 10, 40, 80]) {
    const lines = h.render(width);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  }
  expect(h.render(0)).toEqual([]);
  h.invalidate();
  expect(h.repaint).toHaveBeenCalled();
});

it("displays final answers and errors without writing to main history", async () => {
  const h = harness();
  await h.command("question");
  threads[0].ask.mockImplementationOnce((_question, options) => {
    options.onUpdate({ text: "", status: "Thinking…" });
    return Promise.resolve("**Final answer**");
  });
  h.key("\x1b[A");
  h.key("follow-up");
  h.key("\r");
  await vi.waitFor(() => expect(h.render().join("\n")).toContain("Done"));
  expect(h.render().join("\n")).toContain("Final answer");
  threads[0].ask.mockRejectedValueOnce(new Error("Provider failed\nwith extra detail"));
  h.key("question two");
  h.key("\r");
  await vi.waitFor(() => expect(h.render().join("\n")).toContain("Provider failed"));
  expect(h.render().join("\n")).not.toContain("Final answer");
  expect(h.render().every((line) => !line.includes("\n"))).toBe(true);
});

it("Up reveals an inset input; Enter sends only to the retained aside and keeps input focused", async () => {
  const h = harness();
  await h.command("initial");
  expect(h.render().join("\n")).not.toContain("Reply to aside · Enter send");
  expect(h.key("\x1b[A")).toEqual({ consume: true });
  expect(h.tui.getFocusedComponent()).not.toBe(h.main);
  h.key("follow-up 🎉 中文");
  expect(h.render().join("\n")).toContain("Reply to aside · Enter send");
  expect(h.render().join("\n")).toContain(CURSOR_MARKER);
  for (const width of [1, 2, 3, 4, 5, 6, 10, 40, 80]) {
    expect(h.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  }
  h.key("\r");
  expect(threads[0].ask.mock.calls.map(([question]) => question)).toEqual(["initial", "follow-up 🎉 中文"]);
  expect(create).toHaveBeenCalledOnce();
  expect(h.main.getText()).toBe("");
  expect(h.main.focused).toBe(false);
  expect(h.render().join("\n")).toContain("Reply to aside · Enter send");
  h.key("\r"); // Empty submissions don't create a turn.
  expect(threads[0].ask).toHaveBeenCalledTimes(2);
});

it.each(["\x1b", "\x1b[B", "\x03"])("%j hides input, restores main focus, and preserves the aside draft", async (key) => {
  const h = harness();
  await h.command("question");
  h.key("\x1b[A");
  h.key("unsent draft");
  h.key(key);
  expect(h.tui.getFocusedComponent()).toBe(h.main);
  expect(h.main.focused).toBe(true);
  expect(h.render().join("\n")).not.toContain("unsent draft");
  h.key("\x1b[A");
  expect(h.render().join("\n")).toContain("unsent draft");
  expect(threads[0].ask).toHaveBeenCalledOnce();
});

it("never steals Up from nonempty editors, dialogs, overlays, or key-release events", async () => {
  const h = harness();
  await h.command("question");
  h.main.setText("main draft");
  expect(h.key("\x1b[A")).toBeUndefined();
  h.main.setText("");
  h.setOverlay(true);
  expect(h.key("\x1b[A")).toBeUndefined();
  h.setOverlay(false);
  expect(h.key("\x1b[1;1:3A")).toBeUndefined();
  expect(h.key("\x1b[1;3A")).toBeUndefined(); // Alt+Up still dequeues main work.
  const dialog = { focused: false, handleInput: vi.fn() };
  h.tui.setFocus(dialog);
  h.key("\x1b[A");
  expect(dialog.handleInput).toHaveBeenCalledOnce();
  expect(h.render().join("\n")).not.toContain("Reply to aside · Enter send");
});

it("accepts bracketed paste without submitting it to either agent", async () => {
  const h = harness();
  await h.command("question");
  h.key("\x1b[A");
  h.key("\x1b[200~pasted\nfollow-up\x1b[201~");
  expect(threads[0].ask).toHaveBeenCalledOnce();
  h.key("\r");
  expect(threads[0].ask.mock.calls[1][0]).toContain("pasted");
});

it("shows queued turns without letting older completion overwrite the current turn", async () => {
  const h = harness();
  await h.command("first");
  let finish!: (text: string) => void;
  threads[0].ask.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
  h.key("\x1b[A");
  h.key("second");
  h.key("\r");
  expect(h.render().join("\n")).toContain("1 queued");
  threads[0].ask.mock.calls[1][1].onUpdate({ text: "Second streaming", status: "Answering…" });
  threads[0].ask.mock.calls[0][1].onUpdate({ text: "Late first stream", status: "Answering…" });
  expect(h.render().join("\n")).not.toContain("Late first stream");
  h.key("third");
  h.key("\r");
  finish("Older final");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.render().join("\n")).not.toContain("Older final");
});

it("replaces requests and ignores their late updates, answers and errors", async () => {
  const h = harness();
  await h.command("old");
  const old = threads[0].ask.mock.calls[0][1];
  const signal = create.mock.calls[0][1];
  await h.command("new");
  expect(signal.aborted).toBe(true);
  expect(threads[0].dispose).toHaveBeenCalledOnce();
  old.onUpdate({ text: "STALE", status: "Done" });
  expect(h.render().join("\n")).not.toContain("STALE");
  expect(h.render().join("\n")).toContain("new");
});

it.each(["clear", "session_shutdown", "session_tree", "widget teardown"])("cancels work and removes its input hooks on %s", async (action) => {
  const h = harness();
  await h.command("question");
  h.key("\x1b[A");
  const update = threads[0].ask.mock.calls[0][1];
  if (action === "clear") await h.command("clear");
  else if (action === "widget teardown") h.disposeWidget();
  else h.event(action);
  expect(create.mock.calls[0][1].aborted).toBe(true);
  expect(threads[0].dispose).toHaveBeenCalledOnce();
  expect(h.unsubscribe).toHaveBeenCalledOnce();
  expect(h.tui.getFocusedComponent()).toBe(h.main);
  update.onUpdate({ text: "late", status: "Done" });
  expect(h.render()).toEqual([]);
  expect(h.key("\x1b[A")).toBeUndefined();
});

it("can refocus an unsent reply after an inline dialog returns to the main editor", async () => {
  const h = harness();
  await h.command("question");
  h.key("\x1b[A");
  h.key("preserved draft");
  const dialog = { focused: false };
  h.tui.setFocus(dialog);
  expect(h.key("\x1b[A")).toBeUndefined();
  h.tui.setFocus(h.main);
  expect(h.key("\x1b[A")).toEqual({ consume: true });
  expect(h.render().join("\n")).toContain("preserved draft");
});

it("cleanup leaves a dialog focused and redirects a late restoration to the removed panel", async () => {
  const h = harness();
  await h.command("question");
  h.key("\x1b[A");
  const oldPanel = h.tui.getFocusedComponent();
  const dialog = { focused: false };
  h.tui.setFocus(dialog);
  await h.command("clear");
  expect(h.tui.getFocusedComponent()).toBe(dialog);
  h.tui.setFocus(oldPanel); // The dialog's saved preFocus target.
  expect(h.tui.getFocusedComponent()).toBe(h.main);
});
