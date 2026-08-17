import { afterEach, describe, expect, it } from "vitest";
import {
  getSubagentActivityProvider,
  getSubagentActivityRegistry,
  registerSubagentActivityProvider,
  SUBAGENT_ACTIVITY_REGISTRY_KEY,
  type SubagentActivityProvider,
} from "../src/activity.js";

const globals = globalThis as Record<PropertyKey, unknown>;

describe("subagent activity registry", () => {
  let previous: unknown;

  afterEach(() => {
    if (previous === undefined) {
      delete globals[SUBAGENT_ACTIVITY_REGISTRY_KEY];
    } else {
      globals[SUBAGENT_ACTIVITY_REGISTRY_KEY] = previous;
    }
  });

  it("keeps simultaneous root and child session providers isolated", () => {
    previous = globals[SUBAGENT_ACTIVITY_REGISTRY_KEY];
    delete globals[SUBAGENT_ACTIVITY_REGISTRY_KEY];
    const root: SubagentActivityProvider = {
      getActiveSubagents: () => [{
        id: "root-queued",
        type: "general-purpose",
        description: "Review the change",
        status: "queued",
      }],
    };
    const child: SubagentActivityProvider = {
      getActiveSubagents: () => [{
        id: "child-running",
        type: "Explore",
        description: "Inspect a package",
        status: "running",
      }],
    };

    const unregisterRoot = registerSubagentActivityProvider("root-session", root);
    const unregisterChild = registerSubagentActivityProvider("child-session", child);

    expect(getSubagentActivityRegistry().getActiveSubagents("root-session")).toEqual(root.getActiveSubagents());
    expect(getSubagentActivityRegistry().getActiveSubagents("child-session")).toEqual(child.getActiveSubagents());
    expect(getSubagentActivityProvider("root-session")?.getActiveSubagents()).toEqual(root.getActiveSubagents());

    unregisterChild();
    expect(getSubagentActivityRegistry().getActiveSubagents("root-session")).toEqual(root.getActiveSubagents());
    expect(getSubagentActivityRegistry().getActiveSubagents("child-session")).toEqual([]);
    unregisterRoot();
  });

  it("does not let stale cleanup remove a replacement for the same session", () => {
    previous = globals[SUBAGENT_ACTIVITY_REGISTRY_KEY];
    delete globals[SUBAGENT_ACTIVITY_REGISTRY_KEY];
    const first = { getActiveSubagents: () => [] };
    const replacement = {
      getActiveSubagents: () => [{
        id: "replacement",
        type: "Plan",
        description: "Plan work",
        status: "running" as const,
      }],
    };

    const unregisterFirst = registerSubagentActivityProvider("root-session", first);
    const unregisterReplacement = registerSubagentActivityProvider("root-session", replacement);
    unregisterFirst();

    expect(getSubagentActivityProvider("root-session")?.getActiveSubagents()).toEqual(replacement.getActiveSubagents());
    unregisterReplacement();
    expect(getSubagentActivityProvider("root-session")).toBeUndefined();
  });
});
