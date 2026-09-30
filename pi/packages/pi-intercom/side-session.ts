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
import { getAsideTimeoutMs } from "./config.ts";

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

/**
 * Snapshot of the recipient's active branch used to seed the aside fork.
 *
 * Pi rebuilds every request's context from the session manager, so seeding
 * only `agent.state.messages` on a fork with an empty session manager loses
 * the recipient's history (Pi 0.99 drops it on every request; older hosts
 * dropped it after the first tool call). The fork's SessionManager is
 * therefore built from the branch entries. Hosts whose
 * `SessionManager.inMemory` predates the `entries` parameter ignore it; for
 * those, `legacySeed` carries the messages to seed into agent state instead.
 *
 * Taken synchronously, pinned to the current leaf, and deep-cloned so the fork
 * never aliases or writes back to the recipient's entries.
 */
export interface AsideSnapshot {
  sessionManager: SessionManager;
  legacySeed?: AiMessage[];
}

export function snapshotRecipient(ctx: ExtensionContext): AsideSnapshot {
  try {
    const source = ctx.sessionManager;
    const leafId = source.getLeafId();
    const branch = leafId ? source.getBranch(leafId) : [];
    const header = source.getHeader();
    const entries = structuredClone(header ? [header, ...branch] : branch);
    const inMemory = SessionManager.inMemory as (
      cwd?: string,
      options?: undefined,
      entries?: unknown[],
    ) => SessionManager;
    const sessionManager = inMemory(ctx.cwd, undefined, entries);
    const expected = buildSessionContext(structuredClone(branch), leafId).messages;
    if (expected.length > 0 && sessionManager.buildSessionContext().messages.length === 0) {
      return { sessionManager, legacySeed: expected as AiMessage[] };
    }
    return { sessionManager };
  } catch {
    // If the snapshot can't be built, answer from the question alone.
    return { sessionManager: SessionManager.inMemory(ctx.cwd) };
  }
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

  // Snapshot before the first await so the fork reflects the recipient's
  // context at the moment the aside arrived.
  const snapshot = snapshotRecipient(ctx);
  const registry = ctx.modelRegistry as unknown as { runtime?: unknown };
  const sessionOptions: Record<string, unknown> = {
    cwd: ctx.cwd,
    sessionManager: snapshot.sessionManager,
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

  const timeoutMs = options.timeoutMs ?? getAsideTimeoutMs();
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
    if (snapshot.legacySeed) {
      session.agent.state.messages = snapshot.legacySeed as typeof session.agent.state.messages;
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
