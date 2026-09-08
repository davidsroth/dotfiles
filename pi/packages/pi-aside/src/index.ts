import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import { answerAside, type AsideUpdate } from "./side-session";

export default function aside(pi: ExtensionAPI) {
  let active: AbortController | undefined;

  const clear = (ctx: ExtensionContext) => {
    active?.abort(new Error("Aside cancelled"));
    active = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("aside", undefined);
  };
  pi.on("session_shutdown", (_event, ctx) => clear(ctx));
  pi.on("session_tree", (_event, ctx) => clear(ctx));

  pi.registerCommand("aside", {
    description: "Ask a one-shot read-only side question; /aside clear cancels and dismisses",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        throw new Error("/aside requires Pi's terminal UI");
      }
      const question = args.trim();
      if (question === "clear") { clear(ctx); return; }
      if (!question) {
        ctx.ui.notify("Usage: /aside <question> · /aside clear", "info");
        return;
      }
      clear(ctx);
      const controller = new AbortController();
      active = controller;
      let state: AsideUpdate = { text: "", status: "Thinking…" };
      let error = false;
      let repaint = () => {};
      ctx.ui.setWidget("aside", (tui, theme) => {
        const markdown = new Markdown("", 0, 0, getMarkdownTheme());
        repaint = () => tui.requestRender();
        return {
          render(width) {
            if (width < 1) return [];
            markdown.setText(state.text);
            return [
              truncateToWidth(theme.fg("accent", `Aside · ${question.replace(/\s+/g, " ")}`), width),
              ...markdown.render(width).map((line) => truncateToWidth(line, width)),
              truncateToWidth(theme.fg(error ? "error" : "dim", `${state.status.replace(/\s+/g, " ")} · /aside clear`), width),
            ];
          },
          invalidate() { markdown.invalidate(); },
        };
      }, { placement: "aboveEditor" });

      // Return immediately so the editor (and main agent) remain usable.
      void answerAside(ctx, question, {
        signal: controller.signal,
        onUpdate(update) {
          if (active !== controller) return;
          state = update;
          repaint();
        },
      }).then((answer) => {
        if (active !== controller) return;
        state = { text: answer, status: "Done" };
        repaint();
      }).catch((cause: unknown) => {
        if (active !== controller) return;
        error = true;
        state = { text: "", status: cause instanceof Error ? cause.message : String(cause) };
        repaint();
      });
    },
  });
}
