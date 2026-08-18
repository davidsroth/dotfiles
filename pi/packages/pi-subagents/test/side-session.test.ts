import type { Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  sessionManagerInMemory,
} = vi.hoisted(() => ({
  buildSessionContext: vi.fn(),
  createAgentSession: vi.fn(),
  createExtensionRuntime: vi.fn(() => ({ kind: "aside-extension-runtime" })),
  sessionManagerInMemory: vi.fn(() => ({ kind: "aside-session-manager" })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  SessionManager: { inMemory: sessionManagerInMemory },
}));

import {
  ASIDE_TOOLS,
  answerSubagentAside,
  stripDynamicSystemPromptFooter,
} from "../src/side-session.js";

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 17,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
    ...overrides,
  };
}

function makeSideSession(promptImpl?: (session: any, question: string) => Promise<void>) {
  const listeners: Array<(event: any) => void> = [];
  const state = { messages: [] as any[] };
  const session = {
    agent: { state },
    state,
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return vi.fn(() => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      });
    }),
    prompt: vi.fn(async (question: string) => {
      if (promptImpl) return promptImpl(session, question);
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "snapshot answer" }],
        stopReason: "stop",
        usage: usage(),
      };
      state.messages.push(assistant);
      for (const listener of [...listeners]) {
        listener({ type: "message_end", message: assistant });
      }
    }),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return session;
}

function makeChild() {
  const entries = [{ id: "entry-1", parentId: null, type: "message" }];
  const finalizedMessages = [{
    role: "user",
    content: [{ type: "text", text: "main task context" }],
    timestamp: 1,
  }];
  const child = {
    model: { provider: "test", id: "child-model" },
    modelRuntime: { kind: "child-model-runtime" },
    systemPrompt:
      "child system prompt\nCurrent date and time: Monday\nCurrent working directory: /target",
    sessionManager: {
      getLeafId: vi.fn(() => "entry-1"),
      getEntries: vi.fn(() => entries),
    },
    state: {
      messages: finalizedMessages,
      streamingMessage: { role: "assistant", content: [{ type: "text", text: "partial" }] },
      pendingToolCalls: new Set(["tool-1"]),
    },
    steeringQueue: ["queued steer"],
    followUpQueue: ["queued follow-up"],
    activeTools: ["read", "bash", "edit"],
    isStreaming: true,
    prompt: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
  };
  return { child, entries, finalizedMessages };
}

beforeEach(() => {
  createAgentSession.mockReset();
  buildSessionContext.mockReset();
  sessionManagerInMemory.mockClear();
  createExtensionRuntime.mockClear();
});

describe("answerSubagentAside", () => {
  it("copies finalized context into a distinct read-only session without touching the child", async () => {
    const { child, entries, finalizedMessages } = makeChild();
    const childMessagesBefore = structuredClone(child.state.messages);
    const streamingBefore = structuredClone(child.state.streamingMessage);
    const pendingBefore = [...child.state.pendingToolCalls];
    const steeringQueueBefore = [...child.steeringQueue];
    const followUpQueueBefore = [...child.followUpQueue];
    const activeToolsBefore = [...child.activeTools];
    buildSessionContext.mockReturnValue({ messages: finalizedMessages });

    let seededMessages: any[] | undefined;
    const side = makeSideSession(async (session, question) => {
      expect(question).toBe("What remains?");
      seededMessages = session.state.messages;
      expect(seededMessages).toEqual(finalizedMessages);
      expect(seededMessages).not.toBe(finalizedMessages);
      expect(seededMessages?.[0]).not.toBe(finalizedMessages[0]);

      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "snapshot answer" }],
        stopReason: "stop",
        usage: usage({ cacheWrite1h: 1, reasoning: 3 }),
      };
      session.state.messages.push(assistant);
      // Invoke the registered callback directly so this custom prompt can keep
      // the seeded-message assertions in the same side session.
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "message_end", message: assistant });
    });
    createAgentSession.mockResolvedValue({ session: side });

    const result = await answerSubagentAside(child as any, "What remains?", {
      cwd: "/tmp/child-worktree",
    });

    expect(buildSessionContext).toHaveBeenCalledWith(entries, "entry-1");
    expect(sessionManagerInMemory).toHaveBeenCalledWith("/tmp/child-worktree");
    const options = createAgentSession.mock.calls[0][0];
    expect(options).toMatchObject({
      cwd: "/tmp/child-worktree",
      model: child.model,
      modelRuntime: child.modelRuntime,
      tools: [...ASIDE_TOOLS],
    });
    expect(options.tools).toEqual(["read", "ls", "find", "grep"]);
    expect(options.tools).not.toEqual(expect.arrayContaining(["bash", "edit", "write"]));
    expect(options.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(options.resourceLoader.getSystemPrompt()).toBe("child system prompt");
    expect(options.resourceLoader.getAppendSystemPrompt().join(" ")).toContain("one-off side question");
    expect(result.answer).toBe("snapshot answer");
    expect(result.usage).toEqual(usage({ cacheWrite1h: 1, reasoning: 3 }));

    expect(child.state.messages).toEqual(childMessagesBefore);
    expect(child.state.streamingMessage).toEqual(streamingBefore);
    expect([...child.state.pendingToolCalls]).toEqual(pendingBefore);
    expect(child.steeringQueue).toEqual(steeringQueueBefore);
    expect(child.followUpQueue).toEqual(followUpQueueBefore);
    expect(child.activeTools).toEqual(activeToolsBefore);
    expect(child.isStreaming).toBe(true);
    expect(child.prompt).not.toHaveBeenCalled();
    expect(child.steer).not.toHaveBeenCalled();
    expect(child.followUp).not.toHaveBeenCalled();
    expect(child.abort).not.toHaveBeenCalled();
    expect(side.abort).toHaveBeenCalled();
    expect(side.dispose).toHaveBeenCalledOnce();
  });

  it("aborts and disposes only the side session on timeout", async () => {
    const { child, finalizedMessages } = makeChild();
    buildSessionContext.mockReturnValue({ messages: finalizedMessages });
    const side = makeSideSession(async () => new Promise<void>(() => {}));
    createAgentSession.mockResolvedValue({ session: side });

    await expect(answerSubagentAside(child as any, "slow?", {
      cwd: "/tmp",
      timeoutMs: 5,
    })).rejects.toThrow("aside timed out");

    expect(side.abort).toHaveBeenCalled();
    expect(side.dispose).toHaveBeenCalledOnce();
    expect(child.abort).not.toHaveBeenCalled();
    expect(child.prompt).not.toHaveBeenCalled();
    expect(child.steer).not.toHaveBeenCalled();
  });

  it("aborts and disposes only the side session on parent cancellation", async () => {
    const { child, finalizedMessages } = makeChild();
    buildSessionContext.mockReturnValue({ messages: finalizedMessages });
    const side = makeSideSession(async () => new Promise<void>(() => {}));
    createAgentSession.mockResolvedValue({ session: side });
    const controller = new AbortController();

    const pending = answerSubagentAside(child as any, "cancel?", {
      cwd: "/tmp",
      signal: controller.signal,
    });
    controller.abort("parent cancelled");
    await expect(pending).rejects.toThrow("aside aborted");

    expect(side.abort).toHaveBeenCalled();
    expect(side.dispose).toHaveBeenCalledOnce();
    expect(child.abort).not.toHaveBeenCalled();
  });

  it("rejects a child without an active model before creating a side session", async () => {
    const { child } = makeChild();
    child.model = undefined as any;

    await expect(answerSubagentAside(child as any, "anything?", { cwd: "/tmp" }))
      .rejects.toThrow("no active model");
    expect(createAgentSession).not.toHaveBeenCalled();
  });
});

describe("stripDynamicSystemPromptFooter", () => {
  it("removes only Pi's dynamic date/cwd footer", () => {
    expect(stripDynamicSystemPromptFooter(
      "base\nCurrent date and time: today\nCurrent working directory: /tmp",
    )).toBe("base");
    expect(stripDynamicSystemPromptFooter("base\nkeep this line")).toBe("base\nkeep this line");
  });
});
