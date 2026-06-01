/**
 * advisor.ts — an "advisor" tool that consults a stronger model.
 *
 * Registers an `advisor` tool callable by the LLM. Under the hood it spawns a
 * one-shot subagent (via the SDK's createAgentSession) running a configurable
 * "strong" model, lets it investigate read-only, and returns its advice.
 *
 * Config (all optional) is read from, in increasing precedence:
 *   1. ~/.pi/agent/advisor.json   (global default, tracked in dotfiles)
 *   2. <cwd>/.pi/advisor.json     (project override)
 *
 *   {
 *     "model": "anthropic/claude-opus-4-8",  // "provider/modelId" or fuzzy name
 *     "thinkingLevel": "high",               // off|minimal|low|medium|high|xhigh
 *     "readOnly": true,                      // false => also allow `bash`
 *     "maxTurns": 12                         // 0 = unlimited
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface AdvisorConfig {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  readOnly?: boolean;
  maxTurns?: number;
}

const VALID_THINKING: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const DEFAULTS = {
  thinkingLevel: "high" as ThinkingLevel,
  readOnly: true,
  maxTurns: 12,
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function sanitize(raw: unknown): AdvisorConfig {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: AdvisorConfig = {};
  if (typeof r.model === "string" && r.model.trim()) out.model = r.model.trim();
  if (typeof r.thinkingLevel === "string" && VALID_THINKING.has(r.thinkingLevel)) {
    out.thinkingLevel = r.thinkingLevel as ThinkingLevel;
  }
  if (typeof r.readOnly === "boolean") out.readOnly = r.readOnly;
  if (Number.isInteger(r.maxTurns) && (r.maxTurns as number) >= 0 && (r.maxTurns as number) <= 1000) {
    out.maxTurns = r.maxTurns as number;
  }
  return out;
}

function readConfigFile(path: string): AdvisorConfig {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[advisor] Ignoring malformed config at ${path}: ${reason}`);
    return {};
  }
}

function loadConfig(cwd: string): AdvisorConfig {
  const global = readConfigFile(join(getAgentDir(), "advisor.json"));
  const project = readConfigFile(join(cwd, ".pi", "advisor.json"));
  return { ...global, ...project };
}

// ---------------------------------------------------------------------------
// Model resolution (exact "provider/modelId" then fuzzy)
// ---------------------------------------------------------------------------

interface ModelLike {
  id: string;
  name: string;
  provider: string;
}

function resolveModel(
  input: string | undefined,
  registry: {
    find(provider: string, modelId: string): Model<any> | undefined;
    getAvailable?(): Model<any>[];
    getAll?(): Model<any>[];
  },
  fallback: Model<any> | undefined,
): Model<any> | undefined {
  if (!input) return fallback;

  const all = (registry.getAvailable?.() ?? registry.getAll?.() ?? []) as ModelLike[];
  const availableSet = new Set(all.map((m) => `${m.provider}/${m.id}`.toLowerCase()));

  // 1. Exact "provider/modelId"
  const slash = input.indexOf("/");
  if (slash !== -1 && availableSet.has(input.toLowerCase())) {
    const found = registry.find(input.slice(0, slash), input.slice(slash + 1));
    if (found) return found;
  }

  // 2. Fuzzy match against available models
  const query = input.toLowerCase();
  let best: ModelLike | undefined;
  let bestScore = 0;
  for (const m of all) {
    const id = m.id.toLowerCase();
    const name = m.name.toLowerCase();
    const full = `${m.provider}/${m.id}`.toLowerCase();
    let score = 0;
    if (id === query || full === query) score = 100;
    else if (id.includes(query) || full.includes(query)) score = 60 + (query.length / id.length) * 30;
    else if (name.includes(query)) score = 40 + (query.length / name.length) * 20;
    if (score > bestScore || (score === bestScore && score > 0 && best && m.id > best.id)) {
      bestScore = score;
      best = m;
    }
  }
  if (best && bestScore >= 40) {
    const found = registry.find(best.provider, best.id);
    if (found) return found;
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// System prompt for the advisor subagent
// ---------------------------------------------------------------------------

function buildAdvisorPrompt(cwd: string, readOnly: boolean): string {
  return [
    "You are an expert technical advisor consulted by another AI coding agent.",
    "You are running a strong reasoning model and have been asked for a second opinion,",
    "a design review, or help with a hard problem.",
    "",
    `Working directory: ${cwd}`,
    "",
    readOnly
      ? "You have READ-ONLY access to the codebase (read, grep, find, ls). Investigate as needed, but do not attempt to modify files."
      : "You have access to read and shell tools to investigate the codebase.",
    "",
    "Guidelines:",
    "- Investigate enough to give a grounded, specific answer — cite concrete files/lines when relevant.",
    "- Distinguish what you verified from what you are inferring.",
    "- Be direct about tradeoffs, risks, and uncertainty. Flag anything you could not confirm.",
    "- Give a clear, actionable recommendation. Lead with the bottom line, then the reasoning.",
    "- Be concise. The caller is another agent that will act on your advice.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Subagent runner
// ---------------------------------------------------------------------------

function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const parts: string[] = [];
    for (const c of msg.content) {
      if ((c as any).type === "text" && (c as any).text) parts.push((c as any).text);
    }
    const text = parts.join("").trim();
    if (text) return text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description:
      "Consult a stronger model for a second opinion on a hard problem, design decision, " +
      "tricky bug, or risky change. Spawns an isolated read-only subagent running a " +
      "configurable strong model that investigates the codebase and returns grounded advice. " +
      "Provide a focused question and any context the advisor needs.",
    promptSnippet:
      "Ask a stronger model for a second opinion / design review on a hard or risky problem",
    promptGuidelines: [
      "Use advisor when you face a hard design decision, a subtle bug, or a risky/ambiguous change where a second opinion from a stronger model would reduce risk — not for routine work.",
      "When calling advisor, pass a self-contained question plus the specific context (files, constraints, what you already tried) since the advisor starts with a fresh context.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "The focused question or problem to get advice on. Be specific about what decision or judgment you need.",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Relevant context the advisor needs: file paths, constraints, prior attempts, error messages, design goals. The advisor starts fresh, so include what matters.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
      // Fast-fail if already cancelled — avoids spinning up an expensive subagent session.
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "advisor: cancelled before starting." }], isError: true };
      }
      const cfg = loadConfig(ctx.cwd);
      const readOnly = cfg.readOnly ?? DEFAULTS.readOnly;
      const thinkingLevel = cfg.thinkingLevel ?? DEFAULTS.thinkingLevel;
      const maxTurns = cfg.maxTurns ?? DEFAULTS.maxTurns;

      const model = resolveModel(cfg.model, ctx.modelRegistry as any, ctx.model);
      if (!model) {
        return {
          content: [
            {
              type: "text",
              text:
                "advisor: could not resolve a model. Set `model` in ~/.pi/agent/advisor.json " +
                '(e.g. "anthropic/claude-opus-4-8") or ensure a default model is configured.',
            },
          ],
          isError: true,
        };
      }

      const modelLabel = `${(model as any).provider}/${(model as any).id}`;
      onUpdate?.({
        content: [{ type: "text", text: `Consulting advisor (${modelLabel})…` }],
      });

      // Lean, isolated loader: advisor persona, no extensions/skills/context
      // files. This keeps it fast and prevents the advisor from recursively
      // spawning advisors or other subagents.
      const loader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => buildAdvisorPrompt(ctx.cwd, readOnly),
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();

      const tools = readOnly
        ? ["read", "grep", "find", "ls"]
        : ["read", "grep", "find", "ls", "bash"];

      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        model,
        thinkingLevel,
        modelRegistry: ctx.modelRegistry,
        sessionManager: SessionManager.inMemory(ctx.cwd),
        settingsManager: SettingsManager.create(ctx.cwd, getAgentDir()),
        resourceLoader: loader,
        tools,
      });

      // Turn tracking + soft turn limit, and stream tool activity to the caller.
      let turnCount = 0;
      const normalizedMax = maxTurns > 0 ? maxTurns : undefined;
      let softLimitHit = false;
      const unsub = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "turn_end") {
          turnCount++;
          if (normalizedMax != null && !softLimitHit && turnCount >= normalizedMax) {
            softLimitHit = true;
            session.steer(
              "You have reached your turn limit. Stop investigating and give your final advice now.",
            );
          }
        }
        if (event.type === "tool_execution_start") {
          onUpdate?.({
            content: [{ type: "text", text: `advisor → ${event.toolName}` }],
          });
        }
      });

      // Forward the caller's abort signal to the subagent.
      const onAbort = () => session.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      const prompt = params.context
        ? `${params.question}\n\n--- Context ---\n${params.context}`
        : params.question;

      try {
        await session.prompt(prompt);
      } finally {
        unsub();
        signal?.removeEventListener("abort", onAbort);
      }

      const advice = getLastAssistantText(session) || "(advisor produced no response)";

      return {
        content: [{ type: "text", text: advice }],
        details: { model: modelLabel, turns: turnCount, readOnly, thinkingLevel },
      };
    },
  });
}
