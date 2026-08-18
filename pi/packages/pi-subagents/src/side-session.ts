import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  type ResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

/** Read-only built-in tools available to an aside session. */
export const ASIDE_TOOLS = ["read", "ls", "find", "grep"] as const;

/** Default wall-clock budget for one aside answer. */
export const ASIDE_TIMEOUT_MS = 120_000;

const ASIDE_SYSTEM_PROMPT = [
  "You are answering a one-off side question about a running subagent.",
  "The preceding messages are a read-only snapshot of that subagent's finalized context; its live work continues elsewhere.",
  "Answer the question directly and concisely, but do not continue, steer, interrupt, or modify the main task.",
  "You have only read-only tools (read, ls, find, grep) for inspecting the working directory.",
].join(" ");

/** Strip Pi's dynamic footer so the throwaway session derives its own cwd/date. */
export function stripDynamicSystemPromptFooter(systemPrompt: string): string {
  return systemPrompt
    .replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
    .replace(/\nCurrent working directory:[^\n]*$/u, "")
    .trim();
}

function createAsideResourceLoader(systemPrompt: string): ResourceLoader {
  const extensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  const loader = {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => stripDynamicSystemPromptFooter(systemPrompt),
    // These source methods are required by newer Pi ResourceLoaders but are
    // intentionally kept outside the contextual type for compatibility with
    // the package's older supported SDK floor.
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [ASIDE_SYSTEM_PROMPT],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  return loader as ResourceLoader;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addNestedUsage(total: Usage, usage: Usage): void {
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  total.totalTokens += usage.totalTokens ?? 0;
  total.cost.input += usage.cost?.input ?? 0;
  total.cost.output += usage.cost?.output ?? 0;
  total.cost.cacheRead += usage.cost?.cacheRead ?? 0;
  total.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
  total.cost.total += usage.cost?.total ?? 0;
  if (usage.cacheWrite1h !== undefined) {
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  }
  if (usage.reasoning !== undefined) {
    total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  }
}

function lastAssistantText(session: AgentSession, firstNewMessageIndex: number): string {
  for (let i = session.state.messages.length - 1; i >= firstNewMessageIndex; i--) {
    const message = session.state.messages[i];
    if (message.role !== "assistant") continue;
    const assistant = message as AssistantMessage;
    if (assistant.stopReason === "aborted") throw new Error("aside aborted");
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
  throw new Error("aside returned no assistant response");
}

export interface AsideAnswer {
  answer: string;
  usage: Usage;
}

export interface AnswerSubagentAsideOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Ask a one-off question through a throwaway in-memory session seeded from a
 * running child's finalized SessionManager branch. The live child is read but
 * never prompted, steered, aborted, disposed, or otherwise mutated.
 */
export async function answerSubagentAside(
  child: AgentSession,
  question: string,
  options: AnswerSubagentAsideOptions,
): Promise<AsideAnswer> {
  if (!child.model) throw new Error("target subagent has no active model");

  // Capture the leaf before entries. If the child advances while we clone, the
  // selected path remains pinned to this finalized leaf. SessionManager entries
  // contain only finalized messages, so an in-flight tool result may not appear
  // until a later aside.
  const leafId = child.sessionManager.getLeafId();
  const entries = child.sessionManager.getEntries();
  const context = buildSessionContext(entries, leafId).messages;
  const snapshot = structuredClone(context) as AgentMessage[];
  const snapshotMessageCount = snapshot.length;

  const { session } = await createAgentSession({
    cwd: options.cwd,
    sessionManager: SessionManager.inMemory(options.cwd),
    model: child.model,
    modelRuntime: child.modelRuntime,
    tools: [...ASIDE_TOOLS],
    resourceLoader: createAsideResourceLoader(child.systemPrompt),
  });

  // Never share the target's mutable message array or nested message objects.
  session.agent.state.messages = snapshot;

  const usage = emptyUsage();
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      addNestedUsage(usage, event.message.usage);
    }
  });

  const timeoutMs = options.timeoutMs ?? ASIDE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onExternalAbort = () => {
    void session.abort();
    rejectAbort?.(new Error("aside aborted"));
  };

  try {
    if (options.signal) {
      if (options.signal.aborted) throw new Error("aside aborted");
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const run = session.prompt(question, { source: "extension" });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void session.abort();
        reject(new Error(`aside timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });

    await Promise.race([run, timeout, aborted]);
    return { answer: lastAssistantText(session, snapshotMessageCount), usage };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
    unsubscribe();
    try {
      await session.abort();
    } catch {
      // Best-effort teardown; disposal must still run.
    }
    session.dispose();
  }
}
