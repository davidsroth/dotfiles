import {
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
  "You are answering side questions from the user in a separate, retained conversation, not the main working session.",
  "The preceding main-session messages are a fixed snapshot of its finalized context; that work is continuing elsewhere.",
  "Follow-up side questions refer to this conversation's earlier questions and answers, not later changes to the main session.",
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

export interface AsideTurnOptions {
  onUpdate: (update: AsideUpdate) => void;
  timeoutMs?: number;
}

export interface AsideOptions extends AsideTurnOptions {
  signal: AbortSignal;
}

export interface AsideThread {
  /** Queued FIFO. Emits Thinking… only when active; its deadline starts then. */
  ask(question: string, options: AsideTurnOptions): Promise<string>;
  /** Terminal: rejects active/queued turns and stops their updates immediately. */
  dispose(): void;
}

/** A retained, in-memory context fork; never prompt, abort, or write to the parent. */
export function createAsideThread(ctx: ExtensionContext, signal: AbortSignal): AsideThread {
  signal.throwIfAborted();
  if (!ctx.model) throw new Error("No active model");

  // Capture everything at thread creation, before any awaits or queued questions.
  // Pi rebuilds context from the manager, so seeding agent.state alone loses it.
  const header = ctx.sessionManager.getHeader();
  const snapshot = structuredClone(header
    ? [header, ...ctx.sessionManager.getBranch()]
    : ctx.sessionManager.getBranch());
  const cwd = ctx.cwd;
  const model = ctx.model;
  const thinkingLevel = ctx.thinkingLevel;
  const history = SessionManager.inMemory(cwd, undefined, snapshot);
  // The extension facade does not expose a public ModelRuntime accessor.
  // Reuse its runtime rather than rediscovering credentials or providers.
  const runtime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime) throw new Error("Pi's model runtime is unavailable");
  const loader = resourceLoader(ctx.getSystemPrompt());

  type Turn = {
    question: string;
    options: AsideTurnOptions;
    resolve: (answer: string) => void;
    reject: (reason: unknown) => void;
  };
  const queue: Turn[] = [];
  let active: Turn | undefined;
  let session: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let closeReason: unknown;
  let rejectClosed!: (reason: unknown) => void;
  const terminated = new Promise<never>((_resolve, reject) => { rejectClosed = reject; });
  // Disposal of an idle thread must not produce an unhandled rejection.
  void terminated.catch(() => {});

  function release(child: AgentSession): void {
    // Abort may wait for a provider/tool to settle. Do not delay cancellation,
    // but keep SDK disposal after that wait so live work retains its listeners.
    void (async () => {
      try { await child.abort(); } catch { /* Teardown is best effort. */ }
      try { child.dispose(); } catch { /* Teardown must never reject. */ }
    })();
  }

  function close(reason: unknown): void {
    if (closed) return;
    closed = true;
    closeReason = reason;
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    unsubscribe?.();
    unsubscribe = undefined;
    rejectClosed(reason);
    active?.reject(reason);
    for (const turn of queue.splice(0)) turn.reject(reason);
    if (session) {
      const child = session;
      session = undefined;
      release(child);
    }
  }
  function onAbort(): void { close(signal.reason); }
  signal.addEventListener("abort", onAbort, { once: true });

  async function run(turn: Turn): Promise<void> {
    timer = setTimeout(() => close(new Error("Aside timed out after five minutes")), turn.options.timeoutMs ?? 300_000);
    try {
      turn.options.onUpdate({ text: "", status: "Thinking…" });
      if (closed) throw closeReason;
      if (!session) {
        const creating = createAgentSession({
          cwd, model, modelRuntime: runtime, thinkingLevel,
          tools: ["read", "ls", "find", "grep"],
          sessionManager: history,
          settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
          resourceLoader: loader,
        }).then(({ session: child }) => {
          // Creation has no signal parameter. Never prompt a late result.
          if (closed) {
            release(child);
            throw closeReason;
          }
          session = child;
          return child;
        });
        try { await Promise.race([creating, terminated]); }
        catch (error) { close(error); throw error; }
      }
      if (closed) throw closeReason;
      const child = session!;
      const firstNewMessage = child.state.messages.length;
      let text = "";
      unsubscribe = child.subscribe((event) => {
        if (closed || active !== turn) return;
        if (event.type === "message_start" && event.message.role === "assistant") text = "";
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          text += event.assistantMessageEvent.delta;
          turn.options.onUpdate({ text, status: "Answering…" });
        } else if (event.type === "tool_execution_start") {
          turn.options.onUpdate({ text, status: `Reading · ${event.toolName}` });
        }
      });
      // Own the queue instead of SDK followUp(): that API returns at enqueue,
      // not after that question's response, and would blur response boundaries.
      await Promise.race([child.prompt(turn.question, {
        source: "extension", expandPromptTemplates: false,
        // abort() can finish while prompt() is still awaiting auth preflight.
        // Both supported SDK versions call this hook immediately before the run.
        preflightResult: () => { if (closed) throw closeReason; },
      }), terminated]);
      if (closed) throw closeReason;
      const response = child.state.messages.slice(firstNewMessage).findLast((message) => message.role === "assistant");
      if (!response || response.role !== "assistant") throw new Error("Aside returned no response");
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        const error = new Error(response.errorMessage || `Aside ${response.stopReason}`);
        if (response.stopReason === "aborted") close(error);
        throw error;
      }
      const answer = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
      if (!answer) throw new Error("Aside returned no answer text");
      turn.resolve(answer);
    } catch (error) {
      // Ordinary settled provider errors can recover on the next question.
      // A rejected prompt that leaves live work cannot safely reuse this session.
      if (session?.isStreaming) close(error);
      turn.reject(error);
    } finally {
      clearTimeout(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      active = undefined;
      startNext();
    }
  }

  function startNext(): void {
    if (closed || active) return;
    active = queue.shift();
    if (active) void run(active);
  }

  return {
    ask(question, options) {
      const answer = new Promise<string>((resolve, reject) => {
        if (closed) { reject(closeReason); return; }
        queue.push({ question, options, resolve, reject });
        startNext();
      });
      // The UI may discard a queued promise on dismissal. Keep it rejectable for
      // callers while preventing disposal from producing unhandled rejections.
      void answer.catch(() => {});
      return answer;
    },
    dispose() { close(new Error("Aside thread disposed")); },
  };
}

/** Compatibility API for callers that want a single throwaway question. */
export async function answerAside(ctx: ExtensionContext, question: string, options: AsideOptions): Promise<string> {
  const thread = createAsideThread(ctx, options.signal);
  try { return await thread.ask(question, options); }
  finally { thread.dispose(); }
}
