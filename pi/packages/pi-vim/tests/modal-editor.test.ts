import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalEditor } from "../index.js";
import { PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY } from "../types.js";

const originalRegistry = (globalThis as Record<PropertyKey, unknown>)[
  PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY
];

function editor() {
  return new ModalEditor(
    { terminal: { rows: 30, columns: 100 }, requestRender: vi.fn() } as any,
    { fg: (_color: string, text: string) => text } as any,
    { matches: () => false } as any,
  );
}

function setFakeRegistry(handleNormalLeftArrow: () => boolean) {
  (globalThis as Record<PropertyKey, unknown>)[PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY] = {
    register: vi.fn(),
    handleNormalLeftArrow,
  };
}

describe("ModalEditor optional empty-prompt Left Arrow hook", () => {
  afterEach(() => {
    (globalThis as Record<PropertyKey, unknown>)[PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY] = originalRegistry;
  });

  it("consumes Left Arrow on an empty prompt in NORMAL mode", () => {
    const handler = vi.fn(() => true);
    setFakeRegistry(handler);
    const modal = editor();
    modal.handleInput("\x1b");

    modal.handleInput("\x1b[D");

    expect(handler).toHaveBeenCalledOnce();
    expect((modal as any).state.cursorLine).toBe(0);
    expect((modal as any).state.cursorCol).toBe(0);
  });

  it("consumes Left Arrow on an empty prompt in INSERT mode", () => {
    const handler = vi.fn(() => true);
    setFakeRegistry(handler);
    const modal = editor();

    modal.handleInput("\x1b[D");

    expect(handler).toHaveBeenCalledOnce();
    expect((modal as any).state.cursorLine).toBe(0);
    expect((modal as any).state.cursorCol).toBe(0);
  });

  it("keeps ordinary Left Arrow movement when the prompt is not empty", () => {
    const handler = vi.fn(() => true);
    setFakeRegistry(handler);
    const modal = editor();
    modal.setText("abc");
    (modal as any).state.cursorCol = 2;
    modal.handleInput("\x1b");

    modal.handleInput("\x1b[D");

    expect(handler).not.toHaveBeenCalled();
    expect((modal as any).state.cursorCol).toBe(1);
  });

  it("does not invoke the hook at column zero when the prompt is not empty", () => {
    const handler = vi.fn(() => true);
    setFakeRegistry(handler);
    const modal = editor();
    modal.setText("abc");
    (modal as any).state.cursorCol = 0;
    modal.handleInput("\x1b");

    modal.handleInput("\x1b[D");

    expect(handler).not.toHaveBeenCalled();
    expect((modal as any).state.cursorCol).toBe(0);
  });

  it("keeps the underlying Left Arrow behavior when the empty-prompt handler declines", () => {
    const handler = vi.fn(() => false);
    setFakeRegistry(handler);
    const modal = editor();

    modal.handleInput("\x1b[D");

    expect(handler).toHaveBeenCalledOnce();
    expect((modal as any).state.cursorCol).toBe(0);
  });
});
