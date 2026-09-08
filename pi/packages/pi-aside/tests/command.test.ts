import { beforeEach, expect, it, vi } from "vitest";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import aside from "../src/index";
import { answerAside } from "../src/side-session";

vi.mock("../src/side-session", () => ({ answerAside: vi.fn() }));
const answer = vi.mocked(answerAside);

function harness(mode = "tui") {
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  let component: any;
  const repaint = vi.fn();
  const ctx = {
    mode, ui: {
      notify: vi.fn(),
      setWidget: vi.fn((_key, factory, options) => {
        if (factory) expect(options).toEqual({ placement: "aboveEditor" });
        component = factory?.({ requestRender: repaint }, { fg: (_color: string, text: string) => text });
      }),
    },
  } as unknown as ExtensionCommandContext;
  aside({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    on: (name: string, fn: any) => events.set(name, fn),
  } as unknown as ExtensionAPI);
  return {
    ctx, commands, repaint,
    command: (text: string) => commands.get("aside").handler(text, ctx),
    event: (name: string) => events.get(name)({}, ctx),
    render: (width = 80): string[] => component?.render(width) ?? [],
    invalidate: () => component.invalidate(),
  };
}

beforeEach(() => {
  initTheme("dark", false);
  answer.mockReset();
  answer.mockImplementation(() => new Promise(() => {}));
});

it("registers only /aside, shows usage without calling a model, and requires terminal UI", async () => {
  const h = harness();
  expect([...h.commands.keys()]).toEqual(["aside"]);
  await h.command("");
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "info");
  for (const mode of ["rpc", "print", "json"]) {
    await expect(harness(mode).command("question")).rejects.toThrow("terminal UI");
  }
  expect(answer).not.toHaveBeenCalled();
});

it("returns before the answer finishes and streams a width-safe Markdown panel", async () => {
  const h = harness();
  await h.command("question\nwith emoji 🎉");
  expect(h.render().join("\n")).toContain("Thinking…");
  answer.mock.calls[0][2].onUpdate({ text: "**Bold**\n\n- multilingual 中文 🎉\n\n```ts\nconst long = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';\n```", status: "Answering…" });
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
  // The fake API has no history/messaging or main-agent control methods.
  const h = harness();
  answer.mockResolvedValueOnce("**Final answer**");
  await h.command("question");
  await vi.waitFor(() => expect(h.render().join("\n")).toContain("Done"));
  expect(h.render().join("\n")).toContain("Final answer");
  answer.mockRejectedValueOnce(new Error("Provider failed\nwith extra detail"));
  await h.command("question two");
  await vi.waitFor(() => expect(h.render().join("\n")).toContain("Provider failed"));
  expect(h.render().join("\n")).not.toContain("Final answer");
  expect(h.render().every((line) => !line.includes("\n"))).toBe(true);
});

it("replaces old requests and ignores their late updates, answers and errors", async () => {
  const h = harness();
  let finish!: (text: string) => void;
  answer.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await h.command("old");
  const old = answer.mock.calls[0][2];
  await h.command("new");
  expect(old.signal.aborted).toBe(true);
  old.onUpdate({ text: "STALE", status: "Done" });
  finish("STALE final");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.render().join("\n")).not.toContain("STALE");
  expect(h.render().join("\n")).toContain("new");

  let fail!: (cause: Error) => void;
  answer.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  await h.command("will fail late");
  await h.command("latest");
  fail(new Error("STALE error"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.render().join("\n")).not.toContain("STALE");
});

it.each(["clear", "session_shutdown", "session_tree"])("cancels and removes the panel on %s", async (action) => {
  const h = harness();
  await h.command("question");
  const options = answer.mock.calls[0][2];
  if (action === "clear") await h.command("clear");
  else h.event(action);
  expect(options.signal.aborted).toBe(true);
  options.onUpdate({ text: "late", status: "Done" });
  expect(h.render()).toEqual([]);
});
