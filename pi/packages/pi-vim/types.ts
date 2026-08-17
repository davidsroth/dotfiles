/**
 * Types and constants for vim-mode extension
 */

export type Mode = "normal" | "insert";
export type CharMotion = "f" | "F" | "t" | "T";
export type PendingMotion = CharMotion | null;
export type PendingOperator = "d" | "c" | "y" | null;

export interface LastCharMotion {
  motion: CharMotion;
  char: string;
}

/**
 * Optional cross-extension hook for the literal Left Arrow in NORMAL mode.
 *
 * Extensions must not import pi-vim to use this contract. Instead, replicate
 * this structural shape and use Symbol.for() with this documented key. A
 * handler returns true only when it consumed the key synchronously; any async
 * work it starts is its responsibility to catch. register() returns an
 * ownership-safe cleanup function, so reloads cannot remove a newer handler.
 */
export const PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY = Symbol.for(
  "pi-vim:normal-left-arrow-registry",
);

export type PiVimNormalLeftArrowHandler = () => boolean;

export interface PiVimNormalLeftArrowRegistry {
  register(handler: PiVimNormalLeftArrowHandler): () => void;
  handleNormalLeftArrow(): boolean;
}

/** Return the process-global NORMAL-mode Left Arrow callback registry. */
export function getPiVimNormalLeftArrowRegistry(): PiVimNormalLeftArrowRegistry {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const current = globals[PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY];
  if (
    current
    && typeof current === "object"
    && typeof (current as Partial<PiVimNormalLeftArrowRegistry>).register === "function"
    && typeof (current as Partial<PiVimNormalLeftArrowRegistry>).handleNormalLeftArrow === "function"
  ) {
    return current as PiVimNormalLeftArrowRegistry;
  }

  const handlers = new Map<symbol, PiVimNormalLeftArrowHandler>();
  const registry: PiVimNormalLeftArrowRegistry = {
    register(handler) {
      const registration = Symbol("pi-vim-normal-left-arrow-handler");
      handlers.set(registration, handler);
      return () => {
        // Do not remove a later registration (or any other extension's handler).
        handlers.delete(registration);
      };
    },
    handleNormalLeftArrow() {
      // The newest eligible handler wins, which makes reload registration
      // deterministic while allowing older owners to remain available.
      for (const handler of [...handlers.values()].reverse()) {
        try {
          const result = handler();
          if (result === true) return true;
          // The documented contract is synchronous. Still observe an invalid
          // thenable so a third-party mistake cannot cause an unhandled rejection.
          if (result && typeof (result as unknown as { catch?: unknown }).catch === "function") {
            void (result as unknown as Promise<unknown>).catch(() => {});
          }
        } catch {
          // A failed optional integration must preserve the editor's normal key.
        }
      }
      return false;
    },
  };
  globals[PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY] = registry;
  return registry;
}

// Normal mode key mappings: key -> escape sequence (or null for mode switch)
export const NORMAL_KEYS: Record<string, string | null> = {
  h: "\x1b[D", // left
  j: "\x1b[B", // down
  k: "\x1b[A", // up
  l: "\x1b[C", // right
  "0": "\x01", // line start
  $: "\x05", // line end
  x: null, // delete char (custom clipboard handling)
  D: null, // delete to end of line (custom clipboard handling)
  C: null, // change to end of line (delete to end + insert mode)
  S: null, // substitute line (delete line content + insert mode)
  s: null, // substitute char (delete char + insert mode)
  i: null, // insert mode
  a: null, // append (insert + right)
  A: null, // append at end of line
  I: null, // insert at start of line
  o: null, // open line below
  O: null, // open line above
};

// Character motion keys that wait for a target character
export const CHAR_MOTION_KEYS = new Set<string>(["f", "F", "t", "T"]);

// Escape sequences
export const ESC_LEFT = "\x1b[D";
export const ESC_RIGHT = "\x1b[C";
export const CTRL_A = "\x01"; // line start
export const CTRL_E = "\x05"; // line end
export const CTRL_K = "\x0b"; // kill to end of line
export const CTRL_R = "\x12"; // ctrl+r — readline redo trigger in vim layer
export const CTRL_UNDERSCORE = "\x1f"; // ctrl+_ — readline undo
export const NEWLINE = "\n"; // newline character
export const ESC_UP = "\x1b[A"; // cursor up
export const ESC_DOWN = "\x1b[B"; // cursor down
