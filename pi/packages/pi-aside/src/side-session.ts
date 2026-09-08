import {
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
  type ModelRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

const INSTRUCTIONS = [
  "You are answering a one-off side question from the user, separate from the main working session.",
  "The preceding messages are a snapshot of the main session's finalized context; that work is continuing elsewhere.",
  "Answer only the side question, directly and concisely. Do not continue, steer, or modify the main task.",
  "Only read, ls, find, and grep are available. Ignore inherited instructions to use other tools or take actions.",
  "Your answer appears in a small panel: prefer a few sentences or short bullets. Do not output internal reasoning.",
].join(" ");

export function resourceLoader(systemPrompt: string): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt
      .replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
      .replace(/\nCurrent working directory:[^\n]*$/u, "").trim(),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [INSTRUCTIONS],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export interface AsideUpdate {
  text: string;
  status: string;
}

export interface AsideOptions {
  signal: AbortSignal;
  onUpdate: (update: AsideUpdate) => void;
  timeoutMs?: number;
}

/** A throwaway context fork; never prompt, abort, or write to the parent. */
export async function answerAside(ctx: ExtensionContext, question: string, options: AsideOptions): Promise<string> {
  options.signal.throwIfAborted();
  if (!ctx.model) throw new Error("No active model");

  // Snapshot before the first await, pinned to the current finalized leaf.
  const leaf = ctx.sessionManager.getLeafId();
  const snapshot = structuredClone(buildSessionContext(ctx.sessionManager.getEntries(), leaf).messages);
  const firstNewMessage = snapshot.length;
  // The extension facade does not yet expose a public ModelRuntime accessor.
  // Use the same bridge as intercom's aside; fail rather than rediscover auth.
  const runtime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime) throw new Error("Pi's model runtime is unavailable");

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Aside timed out after five minutes")), options.timeoutMs ?? 300_000);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  let session: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    // Do not let teardown delay panel cancellation or create unhandled rejections.
    if (session) void session.abort().catch(() => {});
    rejectAbort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const creating = createAgentSession({
      cwd: ctx.cwd,
      model: ctx.model,
      modelRuntime: runtime,
      thinkingLevel: ctx.thinkingLevel,
      tools: ["read", "ls", "find", "grep"],
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoader: resourceLoader(ctx.getSystemPrompt()),
    }).then(({ session: created }) => {
      // Creation itself has no signal parameter. Dispose a late result without
      // ever prompting it, even if the caller has already returned on abort.
      if (signal.aborted) {
        created.dispose();
        throw signal.reason;
      }
      session = created;
      return created;
    });
    const child = await Promise.race([creating, aborted]);
    signal.throwIfAborted();
    child.agent.state.messages = snapshot;
    let text = "";
    unsubscribe = child.subscribe((event) => {
      if (signal.aborted) return;
      if (event.type === "message_start" && event.message.role === "assistant") text = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
        options.onUpdate({ text, status: "Answering…" });
      } else if (event.type === "tool_execution_start") {
        options.onUpdate({ text, status: `Reading · ${event.toolName}` });
      }
    });
    await Promise.race([child.prompt(question, { source: "extension", expandPromptTemplates: false }), aborted]);
    signal.throwIfAborted();
    const response = child.state.messages.slice(firstNewMessage).findLast((message) => message.role === "assistant");
    if (!response || response.role !== "assistant") throw new Error("Aside returned no response");
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `Aside ${response.stopReason}`);
    }
    const answer = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if (!answer) throw new Error("Aside returned no answer text");
    return answer;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    unsubscribe?.();
    if (session) {
      // Abort was already requested when cancelled. Keep disposal tied to the
      // actual run settling; do not leave a live tool with disposed listeners.
      const child = session;
      void child.abort().catch(() => {}).finally(() => child.dispose());
    }
  }
}
