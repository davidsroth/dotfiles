// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=pi
// HERDR_INTEGRATION_VERSION=8
// @ts-nocheck

import net from "node:net";
import path from "node:path";

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
  process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const paneId = process.env.HERDR_PANE_ID;
const source = "herdr:pi";

function enabled() {
  return HERDR_ENV === "1" && !!socketPath && !!paneId;
}

function sendRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
  if (!enabled()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      socket.destroy();
      resolve(delivered);
    };

    const socket = net.createConnection(socketEndpoint!);
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
  });
}

async function sendRequest(request: unknown): Promise<void> {
  if (await sendRequestAttempt(request, 500)) {
    return;
  }
  await sendRequestAttempt(request, 1500);
}

type AgentState = "working" | "blocked" | "idle";

type QueuedState = {
  state: AgentState;
  message?: string;
  seq: number;
};

let reportSeq = Date.now() * 1000;
let currentAgentSessionId: string | undefined;
let currentAgentSessionPath: string | undefined;

function nextReportSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

function updateSessionRef(ctx: any): void {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    currentAgentSessionPath =
      typeof file === "string" && file.startsWith("/") ? file : undefined;
  } catch {
    currentAgentSessionPath = undefined;
  }

  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    currentAgentSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    currentAgentSessionId = undefined;
  }
}

function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
  if (currentAgentSessionPath) {
    return { ...params, agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { ...params, agent_session_id: currentAgentSessionId };
  }
  return params;
}

function currentSessionRef(): Record<string, unknown> | undefined {
  if (currentAgentSessionPath) {
    return { agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { agent_session_id: currentAgentSessionId };
  }
  return undefined;
}

function reportSession(sessionStartSource?: string): Promise<void> {
  const sessionRef = currentSessionRef();
  if (!sessionRef) {
    return Promise.resolve();
  }

  return sendRequest({
    id: `${source}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent_session",
    params: {
      pane_id: paneId,
      source,
      agent: "pi",
      seq: nextReportSeq(),
      session_start_source: sessionStartSource,
      ...sessionRef,
    },
  });
}

function sendState(state: AgentState, message?: string, seq = nextReportSeq()): Promise<void> {
  return sendRequest({
    id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent",
    params: withSessionRef({
      pane_id: paneId,
      source,
      agent: "pi",
      state,
      message,
      seq,
    }),
  });
}

let sendInFlight = false;
let queuedState: QueuedState | undefined;

function queueState(state: AgentState, message?: string): void {
  queuedState = { state, message, seq: nextReportSeq() };
  if (!sendInFlight) {
    void drainStateQueue();
  }
}

async function drainStateQueue(): Promise<void> {
  if (sendInFlight) {
    return;
  }

  sendInFlight = true;
  try {
    while (queuedState) {
      const next = queuedState;
      queuedState = undefined;
      await sendState(next.state, next.message, next.seq);
    }
  } finally {
    sendInFlight = false;
    if (queuedState) {
      void drainStateQueue();
    }
  }
}

// Local extension contract published by pi-subagents. The registry is keyed by
// Pi session ID so an embedded child cannot overwrite its root's activity.
const SUBAGENT_ACTIVITY_REGISTRY_KEY = Symbol.for("pi-subagents:activity-registry");

type SubagentActivity = {
  id: string;
  type?: string;
  description?: string;
  status: "queued" | "running";
};

function normalizeSubagentActivity(value: unknown): SubagentActivity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    if (typeof record.id !== "string" || (record.status !== "queued" && record.status !== "running")) {
      return [];
    }
    return [{
      id: record.id,
      ...(typeof record.type === "string" ? { type: record.type } : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      status: record.status,
    }];
  });
}

function readSubagentSnapshot(sessionId: string | undefined): SubagentActivity[] {
  if (!sessionId) return [];
  try {
    const store = (globalThis as Record<PropertyKey, unknown>)[SUBAGENT_ACTIVITY_REGISTRY_KEY] as {
      registry?: { getActiveSubagents?: (id: string) => unknown };
    } | undefined;
    return normalizeSubagentActivity(store?.registry?.getActiveSubagents?.(sessionId));
  } catch {
    // Activity is optional. A malformed third-party global must not break Pi.
    return [];
  }
}

// PATCHED_BY_DOTFILES_HERDR_PI_STATE_V8
export default function (pi) {
  if (!enabled()) {
    return;
  }

  let agentActive = false;
  let compactionActive = false;
  let suppressIdleAfterInboundAsk = false;
  const blockers = new Map<string, string | undefined>();
  let legacyBlockerSequence = 0;
  const activeSubagents = new Map<string, SubagentActivity>();
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let rootSession = false;

  function blockedMessage(): string | undefined {
    return [...blockers.values()].at(-1);
  }

  function desiredState() {
    if (blockers.size > 0) {
      return { state: "blocked" as const, message: blockedMessage() };
    }
    if (agentActive || compactionActive || activeSubagents.size > 0) {
      return { state: "working" as const, message: undefined };
    }
    return { state: "idle" as const, message: undefined };
  }

  function publishState(force = false) {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) {
      return;
    }
    lastState = next.state;
    lastMessage = next.message;
    queueState(next.state, next.message);
  }

  function reconcileSubagents(snapshot = readSubagentSnapshot(currentAgentSessionId)): void {
    activeSubagents.clear();
    for (const subagent of snapshot) activeSubagents.set(subagent.id, subagent);
  }

  function rememberSubagent(data: unknown, status: "queued" | "running"): void {
    if (!rootSession || !currentAgentSessionId || !data || typeof data !== "object") return;
    const record = data as Record<string, unknown>;
    if (record.sessionId !== currentAgentSessionId || typeof record.id !== "string" || !record.id) return;
    activeSubagents.set(record.id, {
      id: record.id,
      ...(typeof record.type === "string" ? { type: record.type } : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      status,
    });
    publishState();
  }

  function forgetSubagent(data: unknown): void {
    if (!rootSession || !currentAgentSessionId || !data || typeof data !== "object") return;
    const record = data as Record<string, unknown>;
    if (record.sessionId !== currentAgentSessionId || typeof record.id !== "string") return;
    const id = record.id;
    activeSubagents.delete(id);
    publishState();
  }

  pi.events.on("herdr:blocked", (data) => {
    if (!rootSession || !data || typeof data !== "object") {
      return;
    }
    const event = data as { id?: unknown; active?: unknown; label?: unknown };
    const id = typeof event.id === "string" && event.id.length > 0 ? event.id : undefined;
    if (event.active) {
      const blockerId = id ?? `legacy:${++legacyBlockerSequence}`;
      // Delete then set keeps the current blocker message deterministic when an
      // existing ID is refreshed.
      blockers.delete(blockerId);
      blockers.set(blockerId, typeof event.label === "string" ? event.label : undefined);
      publishState();
      return;
    }

    if (id) {
      blockers.delete(id);
    } else {
      // Backwards compatibility for older { active, label } producers: close
      // only the most recent legacy blocker, never an identified concurrent one.
      const legacyId = [...blockers.keys()].reverse().find((key) => key.startsWith("legacy:"));
      if (legacyId) blockers.delete(legacyId);
    }
    publishState();
  });

  pi.events.on("subagents:ready", (data) => {
    if (!rootSession || !currentAgentSessionId || !data || typeof data !== "object") return;
    const event = data as Record<string, unknown>;
    if (event.sessionId !== currentAgentSessionId) return;
    reconcileSubagents(normalizeSubagentActivity(event.activeSubagents));
    publishState();
  });
  pi.events.on("subagents:created", (data) => rememberSubagent(data, "queued"));
  pi.events.on("subagents:started", (data) => rememberSubagent(data, "running"));
  pi.events.on("subagents:completed", forgetSubagent);
  pi.events.on("subagents:failed", forgetSubagent);

  pi.on("session_start", async (event, ctx) => {
    // TUI only: RPC/JSON/print modes are headless (no PTY herdr can display),
    // and RPC still reports hasUI=true, so mode is the reliable gate.
    if (ctx?.mode !== "tui") {
      return;
    }
    rootSession = true;
    updateSessionRef(ctx);
    // A reload can replace this extension after subagents already started.
    reconcileSubagents();
    await reportSession(event?.reason);
    await reportSessionSummary(ctx);
    // A reload can replace this extension mid-run without emitting another agent_start.
    agentActive = ctx?.isIdle?.() === false;
    publishState(true);
  });

  function reportSessionSummary(ctx: any): Promise<void> {
    const sessionName = pi.getSessionName?.()?.trim();
    const cwdName = typeof ctx?.cwd === "string" ? path.basename(ctx.cwd) : "";
    const summary = sessionName || cwdName;
    return sendRequest({
      id: `${source}:metadata:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: "pane.report_metadata",
      params: {
        pane_id: paneId,
        source,
        agent: "pi",
        applies_to_source: source,
        tokens: { summary: summary || null },
        seq: nextReportSeq(),
      },
    });
  }

  function isInboundIntercomAsk(ctx: any): boolean {
    try {
      const entry = ctx?.sessionManager?.getLeafEntry?.();
      return entry?.type === "custom_message"
        && entry?.customType === "intercom_message"
        && entry?.details?.message?.expectsReply === true;
    } catch {
      return false;
    }
  }

  pi.on("session_info_changed", (_event, ctx) => {
    if (!rootSession) return;
    void reportSessionSummary(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!rootSession) return;
    suppressIdleAfterInboundAsk = isInboundIntercomAsk(ctx);
  });

  pi.on("session_before_compact", () => {
    if (!rootSession) return;
    compactionActive = true;
    publishState();
  });

  function finishCompaction() {
    if (!rootSession) return;
    compactionActive = false;
    publishState();
  }

  pi.on("session_compact", finishCompaction);
  pi.on("session_compact_failed", finishCompaction);

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) {
      return;
    }
    updateSessionRef(ctx);
    void reportSession();
    agentActive = true;
    publishState();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || ctx?.isIdle?.() !== true) {
      return;
    }

    agentActive = false;
    if (suppressIdleAfterInboundAsk) {
      suppressIdleAfterInboundAsk = false;
      return;
    }
    publishState();
  });
}
