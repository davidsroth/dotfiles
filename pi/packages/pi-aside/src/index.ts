import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AsidePanel } from "./panel";
import { createAsideThread } from "./side-session";

export default function aside(pi: ExtensionAPI) {
  let active: { clear(): void } | undefined;

  const clear = (ctx: ExtensionContext) => {
    active?.clear();
    active = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("aside", undefined);
  };
  pi.on("session_shutdown", (_event, ctx) => clear(ctx));
  pi.on("session_tree", (_event, ctx) => clear(ctx));

  pi.registerCommand("aside", {
    description: "Start a read-only side conversation; ↑ replies; /aside clear dismisses",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") throw new Error("/aside requires Pi's terminal UI");
      const question = args.trim();
      if (question === "clear") { clear(ctx); return; }
      if (!question) {
        ctx.ui.notify("Usage: /aside <question> · ↑ reply with an empty prompt · /aside clear", "info");
        return;
      }
      clear(ctx);
      const controller = new AbortController();
      const thread = createAsideThread(ctx, controller.signal);
      let panel: AsidePanel | undefined;
      let unsubscribe: (() => void) | undefined;
      let pending = 0;
      let nextTurn = 0;
      let displayedTurn = 0;
      let disposed = false;
      const conversation = {
        clear() {
          if (disposed) return;
          disposed = true;
          controller.abort(new Error("Aside cancelled"));
          thread.dispose();
          unsubscribe?.();
          unsubscribe = undefined;
          panel?.dispose();
        },
      };
      active = conversation;
      const send = (question: string) => {
        if (active !== conversation || disposed) return;
        const turn = ++nextTurn;
        panel?.setPending(++pending);
        void thread.ask(question, {
          onUpdate(update) {
            if (active !== conversation || disposed || displayedTurn > turn) return;
            displayedTurn = turn;
            panel?.update(question, update);
          },
        }).then((answer) => {
          if (active === conversation && !disposed && displayedTurn === turn) {
            panel?.update(question, { text: answer, status: "Done" });
          }
        }).catch((cause: unknown) => {
          if (active === conversation && !disposed && displayedTurn <= turn) {
            displayedTurn = turn;
            panel?.update(question, { text: "", status: cause instanceof Error ? cause.message : String(cause) }, true);
          }
        }).finally(() => {
          if (active === conversation && !disposed) panel?.setPending(--pending);
        });
      };
      try {
        ctx.ui.setWidget("aside", (tui, theme) => {
          panel = new AsidePanel(tui, theme, question, send, () => conversation.clear());
          unsubscribe = ctx.ui.onTerminalInput((data) => panel?.onTerminalInput(data));
          return panel;
        }, { placement: "aboveEditor" });
        // Return immediately: the main editor and agent remain usable.
        send(question);
      } catch (cause) {
        clear(ctx);
        throw cause;
      }
    },
  });
}
