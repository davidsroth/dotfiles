/**
 * Optional structural contract with pi-vim. Do not import pi-vim: packages can
 * load independently. Keep the documented key and shape in sync with
 * pi-vim/types.ts.
 *
 * A handler returns true only when it synchronously claims the key. Handlers
 * that start async UI work must catch their own promise rejections.
 */
export const PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY = Symbol.for(
  "pi-vim:normal-left-arrow-registry",
);

type PiVimNormalLeftArrowHandler = () => boolean;

type PiVimNormalLeftArrowRegistry = {
  register(handler: PiVimNormalLeftArrowHandler): () => void;
  handleNormalLeftArrow(): boolean;
};

function registry(): PiVimNormalLeftArrowRegistry {
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
  const created: PiVimNormalLeftArrowRegistry = {
    register(handler) {
      const registration = Symbol("pi-vim-normal-left-arrow-handler");
      handlers.set(registration, handler);
      return () => {
        handlers.delete(registration);
      };
    },
    handleNormalLeftArrow() {
      for (const handler of [...handlers.values()].reverse()) {
        try {
          const result = handler();
          if (result === true) return true;
          if (result && typeof (result as unknown as { catch?: unknown }).catch === "function") {
            void (result as unknown as Promise<unknown>).catch(() => {});
          }
        } catch {
          // An optional integration failure must leave pi-vim's editor usable.
        }
      }
      return false;
    },
  };
  globals[PI_VIM_NORMAL_LEFT_ARROW_REGISTRY_KEY] = created;
  return created;
}

/** Register a root TUI callback and receive ownership-safe unregister cleanup. */
export function registerPiVimNormalLeftArrowHandler(handler: PiVimNormalLeftArrowHandler): () => void {
  return registry().register(handler);
}
