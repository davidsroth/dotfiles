import {
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  type AgentSession,
  type ExtensionContext,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message as AiMessage } from "@earendil-works/pi-ai";

/**
 * Answers an intercom "aside" question out of band, without disturbing the
 * recipient session.
 *
 * The recipient's persisted session history, its on-screen timeline, and its
 * current turn are all untouched: we spin up a throwaway, fully in-memory
 * {@link AgentSession} seeded with a read-only snapshot of the recipient's
 * current context, run a single prompt against it, and return the assistant's
 * text. Nothing here writes back to `ctx.sessionManager`.
 */

/** Read-only built-in tools the aside sub-session may use to inspect the repo. */
export const ASIDE_TOOLS = ["read", "ls", "find", "grep"] as const;

/** Default wall-clock budget for a single aside answer. */
export const ASIDE_TIMEOUT_MS = 120_000;

const ASIDE_SYSTEM_PROMPT = [
  "You are answering a one-off side question from another pi session (an aside), separate from your main working session.",
  "The preceding messages, if any, are a read-only snapshot of your main session's context — that work is being handled elsewhere and you must not try to continue or modify it.",
  "You have read-only tools (read/ls/find/grep) to inspect the working directory if it helps you answer accurately.",
  "Answer the question directly and concisely. Do not attempt to take actions, make changes, or hand work back to the main session.",
].join(" ");

/** Strip pi's dynamic system-prompt footer so the sub-session re-derives its own. */
function stripDynamicSystemPromptFooter(systemPrompt: string): string {
  return systemPrompt
    .replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
    .replace(/\nCurrent working directory:[^\n]*$/u, "")
    .trim();
}

function createAsideResourceLoader(ctx: ExtensionContext): ResourceLoader {
  const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

  const loader = {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    // Required by pi >=0.83. Keep these out of the contextual object type so
    // the same source remains loadable against older pi SDK ResourceLoaders.
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [ASIDE_SYSTEM_PROMPT],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  return loader as ResourceLoader;
}

function lastAssistantText(session: AgentSession): string {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message.role === "assistant") {
      const assistant = message as AssistantMessage & { stopReason?: string; errorMessage?: string };
      if (assistant.stopReason === "aborted") throw new Error("aborted");
      if (assistant.stopReason === "error") {
        throw new Error(assistant.errorMessage || "aside model request failed");
      }
      const text = assistant.content
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!text) throw new Error("aside returned no text response");
      return text;
    }
  }
  throw new Error("aside returned no assistant response");
}

export interface AnswerAsideOptions {
  timeoutMs?: number;
  /** Optional external cancellation (e.g. extension shutdown). */
  signal?: AbortSignal;
}

/**
 * Run `question` against an in-memory fork of the recipient's context and
 * return the assistant's answer text. Throws if no model is available or the
 * run times out / is aborted.
 */
export async function answerAside(
  ctx: ExtensionContext,
  question: string,
  options: AnswerAsideOptions = {},
): Promise<string> {
  const model = ctx.model;
  if (!model) {
    throw new Error("no active model in the target session");
  }

  const registry = ctx.modelRegistry as unknown as { runtime?: unknown };
  const sessionOptions: Record<string, unknown> = {
    cwd: ctx.cwd,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    model,
    tools: [...ASIDE_TOOLS],
    resourceLoader: createAsideResourceLoader(ctx),
  };
  // Pi <=0.79 accepted ModelRegistry directly; Pi >=0.80 accepts the
  // underlying ModelRuntime. Select at runtime so one patch works across the
  // SDK range supported by upstream pi-intercom.
  if (registry.runtime) {
    sessionOptions.modelRuntime = registry.runtime;
  } else {
    sessionOptions.modelRegistry = ctx.modelRegistry;
  }

  const { session } = await createAgentSession(
    sessionOptions as Parameters<typeof createAgentSession>[0],
  );

  const timeoutMs = options.timeoutMs ?? ASIDE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onExternalAbort = () => {
    void session.abort();
    rejectAbort?.(new Error("aborted"));
  };

  try {
    // Capture the leaf before entries so a concurrently advancing main session
    // cannot give buildSessionContext a leaf newer than the snapshot.
    try {
      const leafId = ctx.sessionManager.getLeafId();
      const entries = ctx.sessionManager.getEntries();
      const seed = buildSessionContext(entries, leafId).messages;
      if (seed.length > 0) {
        session.agent.state.messages = seed as AiMessage[] as typeof session.agent.state.messages;
      }
    } catch {
      // If the snapshot can't be built, answer from the question alone.
    }

    if (options.signal) {
      if (options.signal.aborted) throw new Error("aborted");
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const run = session.prompt(question, { source: "extension" });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void session.abort();
        reject(new Error(`aside timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });

    await Promise.race([run, timeout, aborted]);
    return lastAssistantText(session);
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
    try {
      await session.abort();
    } catch {
      // best-effort
    }
    session.dispose();
  }
}
