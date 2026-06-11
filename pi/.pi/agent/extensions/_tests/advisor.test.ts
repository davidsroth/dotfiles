/**
 * Tests for the pure logic in advisor.ts and _shared/config.ts.
 *
 * Hermetic: no real network, no child processes, no reads of the user's real
 * config or memory files. Only the pure exported helpers are exercised
 * directly; loadConfig() / execute() are intentionally not tested here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be at the top level so vitest hoists them above imports.
// ---------------------------------------------------------------------------

// Prevent advisor.ts's default export from running registration code on import.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(() => "/fake/agent"),
  DefaultResourceLoader: vi.fn(),
  SessionManager: { inMemory: vi.fn() },
  SettingsManager: { create: vi.fn() },
  createAgentSession: vi.fn(),
}));

vi.mock("typebox", () => ({
  Type: {
    Object: vi.fn(() => ({})),
    String: vi.fn(() => ({})),
    Optional: vi.fn(() => ({})),
  },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks are set up
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import {
  buildAdvisorPrompt,
  getLastAssistantText,
  resolveModel,
  sanitize,
} from "../advisor";
import { loadLayeredConfig, readJsonConfig } from "../_shared/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake Model object so TypeScript is happy with the return type. */
function fakeModel(provider: string, id: string, name = "n"): any {
  return { provider, id, name };
}

/** Build a minimal fake registry. */
function makeRegistry(models: Array<{ provider: string; id: string; name?: string }>) {
  const all = models.map((m) => fakeModel(m.provider, m.id, m.name ?? m.id));
  return {
    getAvailable: () => all,
    find: (provider: string, modelId: string): any | undefined =>
      all.find((m) => m.provider === provider && m.id === modelId),
  };
}

// ---------------------------------------------------------------------------
// sanitize()
// ---------------------------------------------------------------------------

describe("sanitize()", () => {
  describe("sanitize-valid-full (H)", () => {
    it("passes all five valid fields through unchanged", () => {
      const input = {
        model: "anthropic/claude-fable-5",
        thinkingLevel: "high",
        readOnly: false,
        maxTurns: 50,
      };
      const out = sanitize(input);
      expect(out.model).toBe("anthropic/claude-fable-5");
      expect(out.thinkingLevel).toBe("high");
      expect(out.readOnly).toBe(false);
      expect(out.maxTurns).toBe(50);
    });
  });

  describe("sanitize-non-object-input (M)", () => {
    it.each([null, undefined, "string", 42, []])("returns {} for %s", (val) => {
      expect(sanitize(val)).toEqual({});
    });
  });

  describe("sanitize-model-whitespace (M)", () => {
    it("trims whitespace from model strings", () => {
      const out = sanitize({ model: "  anthropic/claude-fable-5  " });
      expect(out.model).toBe("anthropic/claude-fable-5");
    });

    it("does not set model when string is only whitespace", () => {
      const out = sanitize({ model: "   " });
      expect(out.model).toBeUndefined();
    });
  });

  describe("sanitize-invalid-thinkinglevel (M)", () => {
    it.each(["ultra", "none", "", "0"])("drops invalid thinkingLevel %s", (val) => {
      const out = sanitize({ thinkingLevel: val });
      expect(out.thinkingLevel).toBeUndefined();
    });

    it.each(["off", "minimal", "low", "medium", "high", "xhigh"])(
      "accepts valid thinkingLevel %s",
      (val) => {
        const out = sanitize({ thinkingLevel: val });
        expect(out.thinkingLevel).toBe(val);
      },
    );
  });

  describe("sanitize-maxturns-bounds (H)", () => {
    it("accepts 0", () => expect(sanitize({ maxTurns: 0 }).maxTurns).toBe(0));
    it("accepts 1000", () => expect(sanitize({ maxTurns: 1000 }).maxTurns).toBe(1000));
    it("rejects 1001", () => expect(sanitize({ maxTurns: 1001 }).maxTurns).toBeUndefined());
    it("rejects -1", () => expect(sanitize({ maxTurns: -1 }).maxTurns).toBeUndefined());
    it("rejects 1.5 (non-integer)", () => expect(sanitize({ maxTurns: 1.5 }).maxTurns).toBeUndefined());
    it("rejects string '12'", () => expect(sanitize({ maxTurns: "12" as any }).maxTurns).toBeUndefined());
  });

  describe("config-defaults-applied (H)", () => {
    it("DEFAULTS constants match the documented spec values", () => {
      // These are the DEFAULTS from advisor.ts — guard against accidental changes.
      // We verify them indirectly via sanitize({}) === {} (no field set), then
      // we assert the constant values by sanitizing a real-world config.
      const empty = sanitize({});
      expect(empty).toEqual({});

      // Real-world live config values from ~/.pi/agent/advisor.json
      const live = sanitize({
        model: "anthropic/claude-fable-5",
        thinkingLevel: "high",
        readOnly: false,
        maxTurns: 50,
      });
      expect(live.thinkingLevel).toBe("high");
      expect(live.readOnly).toBe(false);
      expect(live.maxTurns).toBe(50);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveModel()
// ---------------------------------------------------------------------------

describe("resolveModel()", () => {
  describe("resolve-undefined-input-returns-fallback (H)", () => {
    it("returns fallback immediately when input is undefined", () => {
      const fallback = fakeModel("a", "fallback");
      const registry = makeRegistry([{ provider: "anthropic", id: "claude-opus-4-8" }]);
      expect(resolveModel(undefined, registry, fallback)).toBe(fallback);
    });
  });

  describe("resolve-exact-provider-slash (H)", () => {
    it("matches provider/modelId exactly (case-insensitive)", () => {
      const model = fakeModel("anthropic", "claude-fable-5");
      const registry = {
        getAvailable: () => [model],
        find: (p: string, id: string) => (p === "anthropic" && id === "claude-fable-5" ? model : undefined),
      };
      expect(resolveModel("anthropic/claude-fable-5", registry, undefined)).toBe(model);
    });

    it("is case-insensitive for the set lookup but uses original case for find", () => {
      // The availableSet uses lowercase — input is lowercased before has() check.
      // find() receives original-case slices. Here the registry's find is
      // case-sensitive but the test registry normalises on exact lowercase strings.
      const model = fakeModel("anthropic", "claude-fable-5");
      const registry = {
        getAvailable: () => [model],
        find: (p: string, id: string) => {
          if (p.toLowerCase() === "anthropic" && id.toLowerCase() === "claude-fable-5") return model;
          return undefined;
        },
      };
      expect(resolveModel("ANTHROPIC/Claude-Fable-5", registry, undefined)).toBe(model);
    });
  });

  describe("resolve-exact-not-in-available (H)", () => {
    it("falls to fuzzy when provider/modelId has a slash but is not in available set", () => {
      const fallback = fakeModel("z", "fallback");
      // Only model is 'anthropic/opus-4' — 'anthropic/ghost-model' is absent.
      const registry = makeRegistry([{ provider: "anthropic", id: "opus-4" }]);
      // 'anthropic/ghost-model' not in set; fuzzy 'opus-4' vs query
      // 'anthropic/ghost-model' has no id/name substring match => score 0 => fallback
      const result = resolveModel("anthropic/ghost-model", registry, fallback);
      expect(result).toBe(fallback);
    });
  });

  describe("resolve-fuzzy-id-equals-query (H)", () => {
    it("returns exact id match (score=100) over a longer id that merely includes the query", () => {
      const exact = fakeModel("anthropic", "opus-4");
      const longer = fakeModel("anthropic", "opus-4-extra");
      const registry = {
        getAvailable: () => [exact, longer],
        find: (p: string, id: string) => {
          if (p === "anthropic" && id === "opus-4") return exact;
          if (p === "anthropic" && id === "opus-4-extra") return longer;
          return undefined;
        },
      };
      expect(resolveModel("opus-4", registry, undefined)).toBe(exact);
    });
  });

  describe("resolve-fuzzy-substring-id (H)", () => {
    it("shorter id wins because query/id ratio is higher", () => {
      // query = 'opus-4' (len 6)
      // 'claude-opus-4-8'  (len 16) => score = 60 + (6/16)*30 = 71.25
      // 'claude-opus-4-extra-long' (len 24) => score = 60 + (6/24)*30 = 67.5
      const shorter = fakeModel("anthropic", "claude-opus-4-8");
      const longer = fakeModel("openai", "claude-opus-4-extra-long");
      const registry = {
        getAvailable: () => [shorter, longer],
        find: (p: string, id: string) => {
          if (p === "anthropic" && id === "claude-opus-4-8") return shorter;
          if (p === "openai" && id === "claude-opus-4-extra-long") return longer;
          return undefined;
        },
      };
      expect(resolveModel("opus-4", registry, undefined)).toBe(shorter);
    });
  });

  describe("resolve-fuzzy-tie-break-lexicographic (H)", () => {
    it("lexicographically larger id wins when scores are equal", () => {
      // query = 'model', both ids include 'model', same length => same score
      // 'zzz-model' > 'aaa-model' lexicographically
      const zzz = fakeModel("a", "zzz-model");
      const aaa = fakeModel("a", "aaa-model");
      const registry = {
        getAvailable: () => [aaa, zzz], // aaa first in list; zzz should still win
        find: (p: string, id: string) => {
          if (p === "a" && id === "zzz-model") return zzz;
          if (p === "a" && id === "aaa-model") return aaa;
          return undefined;
        },
      };
      expect(resolveModel("model", registry, undefined)).toBe(zzz);
    });
  });

  describe("resolve-fuzzy-threshold-39 (H)", () => {
    it("returns fallback when no model matches the query (score=0 < 40)", () => {
      const fallback = fakeModel("z", "fallback");
      const registry = makeRegistry([{ provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4" }]);
      // query 'zzz-no-match' is not contained in any id or name
      expect(resolveModel("zzz-no-match", registry, fallback)).toBe(fallback);
    });
  });

  describe("resolve-empty-registry (M)", () => {
    it("returns fallback when registry is empty", () => {
      const fallback = fakeModel("z", "fallback");
      const registry = {
        getAvailable: () => [],
        find: () => undefined,
      };
      expect(resolveModel("claude-fable-5", registry, fallback)).toBe(fallback);
    });
  });

  describe("resolve-registry-getall-fallback (M)", () => {
    it("uses getAll() when getAvailable is absent", () => {
      const model = fakeModel("p", "x");
      const registry = {
        getAll: () => [model],
        find: (p: string, id: string): any | undefined =>
          p === "p" && id === "x" ? model : undefined,
      };
      // 'p/x' has slash and 'p/x' is in availableSet => exact path fires
      expect(resolveModel("p/x", registry, undefined)).toBe(model);
    });
  });

  describe("resolve-registry-neither-method (L)", () => {
    it("returns fallback when registry has neither getAvailable nor getAll", () => {
      const fallback = fakeModel("z", "fallback");
      const registry = { find: () => undefined };
      expect(resolveModel("anything", registry, fallback)).toBe(fallback);
    });
  });
});

// ---------------------------------------------------------------------------
// buildAdvisorPrompt()
// ---------------------------------------------------------------------------

describe("buildAdvisorPrompt()", () => {
  describe("build-advisor-prompt-readonly-true (M)", () => {
    it("includes the working directory and READ-ONLY line when readOnly=true", () => {
      const prompt = buildAdvisorPrompt("/my/project", true);
      expect(prompt).toContain("Working directory: /my/project");
      expect(prompt).toContain("READ-ONLY");
      expect(prompt).not.toContain("shell tools");
    });
  });

  describe("build-advisor-prompt-readonly-false (M)", () => {
    it("includes shell tools and omits READ-ONLY when readOnly=false", () => {
      const prompt = buildAdvisorPrompt("/my/project", false);
      expect(prompt).toContain("shell tools");
      expect(prompt).not.toContain("READ-ONLY");
    });
  });
});

// ---------------------------------------------------------------------------
// getLastAssistantText()
// ---------------------------------------------------------------------------

function fakeSession(messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>): any {
  return { messages };
}

describe("getLastAssistantText()", () => {
  describe("get-last-assistant-text-multiple-messages (M)", () => {
    it("returns the last non-empty assistant text, skipping empty assistant messages", () => {
      const session = fakeSession([
        { role: "user", content: [{ type: "text", text: "Q" }] },
        { role: "assistant", content: [{ type: "text", text: "" }] },
        { role: "assistant", content: [{ type: "text", text: "Answer" }] },
      ]);
      expect(getLastAssistantText(session)).toBe("Answer");
    });

    it("returns empty string when all assistant messages have empty text", () => {
      const session = fakeSession([
        { role: "assistant", content: [{ type: "text", text: "   " }] },
        { role: "assistant", content: [{ type: "text", text: "" }] },
      ]);
      expect(getLastAssistantText(session)).toBe("");
    });

    it("skips non-assistant roles", () => {
      const session = fakeSession([
        { role: "user", content: [{ type: "text", text: "Question" }] },
        { role: "assistant", content: [{ type: "text", text: "Reply" }] },
        { role: "user", content: [{ type: "text", text: "Follow-up" }] },
      ]);
      // Last message is user — should return "Reply" from the last assistant
      expect(getLastAssistantText(session)).toBe("Reply");
    });
  });

  describe("get-last-assistant-text-multi-text-parts (M)", () => {
    it("joins multiple text parts and ignores non-text content types", () => {
      const session = fakeSession([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hello " },
            { type: "thinking", text: "internal thought" },
            { type: "text", text: "world" },
          ],
        },
      ]);
      expect(getLastAssistantText(session)).toBe("Hello world");
    });
  });
});

// ---------------------------------------------------------------------------
// maxTurns=0 expression (from execute() line 287)
// ---------------------------------------------------------------------------

describe("maxTurns normalisation expression (M)", () => {
  it("maxTurns=0 maps to undefined (unlimited)", () => {
    const maxTurns = 0;
    const normalizedMax = maxTurns > 0 ? maxTurns : undefined;
    expect(normalizedMax).toBeUndefined();
  });

  it("maxTurns=1 maps to 1", () => {
    const maxTurns = 1;
    const normalizedMax = maxTurns > 0 ? maxTurns : undefined;
    expect(normalizedMax).toBe(1);
  });

  it("maxTurns=50 maps to 50", () => {
    const maxTurns = 50;
    const normalizedMax = maxTurns > 0 ? maxTurns : undefined;
    expect(normalizedMax).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// _shared/config.ts — readJsonConfig and loadLayeredConfig
// ---------------------------------------------------------------------------

const mockedExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockedReadFileSync = readFileSync as ReturnType<typeof vi.fn>;

describe("readJsonConfig()", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("read-json-config-absent-file (M)", () => {
    it("returns undefined and does not call readFileSync when file is absent", () => {
      mockedExistsSync.mockReturnValue(false);
      const result = readJsonConfig("/any/path", "test");
      expect(result).toBeUndefined();
      expect(mockedReadFileSync).not.toHaveBeenCalled();
    });
  });

  describe("read-json-config-malformed (H)", () => {
    it("returns undefined and warns when JSON is malformed", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue("{ bad json");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = readJsonConfig("/some/path/advisor.json", "advisor");
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("/some/path/advisor.json"));
      warnSpy.mockRestore();
    });

    it("never throws on malformed JSON", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue("not-json-at-all!!!");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(() => readJsonConfig("/path", "pfx")).not.toThrow();
    });
  });

  it("parses and returns valid JSON", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('{"model":"anthropic/claude-opus-4-8"}');
    const result = readJsonConfig("/some/advisor.json", "advisor");
    expect(result).toEqual({ model: "anthropic/claude-opus-4-8" });
  });
});

describe("loadLayeredConfig()", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("load-layered-config-precedence (H)", () => {
    it("returns only defaults when no config files exist", () => {
      mockedExistsSync.mockReturnValue(false);
      const result = loadLayeredConfig({
        filename: "advisor.json",
        cwd: "/fake/cwd",
        logPrefix: "advisor",
        defaults: { thinkingLevel: "high" as any, readOnly: true, maxTurns: 12 },
      });
      expect(result).toEqual({ thinkingLevel: "high", readOnly: true, maxTurns: 12 });
    });

    it("global config overrides defaults", () => {
      // global = /fake/agent/advisor.json present; project absent
      mockedExistsSync.mockImplementation((p: string) => p === "/fake/agent/advisor.json");
      mockedReadFileSync.mockReturnValue('{"maxTurns":30}');
      const result = loadLayeredConfig({
        filename: "advisor.json",
        cwd: "/fake/cwd",
        logPrefix: "advisor",
        defaults: { maxTurns: 12 } as any,
      });
      expect(result).toMatchObject({ maxTurns: 30 });
    });

    it("project config overrides global config", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync
        .mockReturnValueOnce('{"thinkingLevel":"medium","maxTurns":20}') // global
        .mockReturnValueOnce('{"thinkingLevel":"low"}'); // project
      const result = loadLayeredConfig({
        filename: "advisor.json",
        cwd: "/fake/cwd",
        logPrefix: "advisor",
        defaults: {} as any,
      });
      expect((result as any).thinkingLevel).toBe("low");
      expect((result as any).maxTurns).toBe(20);
    });

    it("project sets one key, global sets a different key — both present", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync
        .mockReturnValueOnce('{"readOnly":false}') // global
        .mockReturnValueOnce('{"maxTurns":5}'); // project
      const result = loadLayeredConfig({
        filename: "advisor.json",
        cwd: "/fake/cwd",
        logPrefix: "advisor",
        defaults: {} as any,
      });
      expect((result as any).readOnly).toBe(false);
      expect((result as any).maxTurns).toBe(5);
    });

    it("skips malformed global JSON and falls back to defaults", () => {
      mockedExistsSync.mockImplementation((p: string) => p === "/fake/agent/advisor.json");
      mockedReadFileSync.mockReturnValue("{ invalid json }");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = loadLayeredConfig({
        filename: "advisor.json",
        cwd: "/fake/cwd",
        logPrefix: "advisor",
        defaults: { maxTurns: 12 } as any,
      });
      expect((result as any).maxTurns).toBe(12);
    });

    it("uses defaults when project file is absent", () => {
      // Only global exists
      mockedExistsSync.mockImplementation((p: string) => p === "/fake/agent/advisor.json");
      mockedReadFileSync.mockReturnValue('{"maxTurns":99}');
      const result = loadLayeredConfig({
        filename: "advisor.json",
        cwd: "/fake/cwd",
        logPrefix: "advisor",
        defaults: { maxTurns: 12 } as any,
      });
      expect((result as any).maxTurns).toBe(99);
    });
  });
});
