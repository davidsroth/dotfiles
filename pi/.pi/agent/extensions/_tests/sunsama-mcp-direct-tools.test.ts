import { describe, expect, it } from "vitest";
import { resolveConfig } from "../sunsama-mcp/config";
import { DEFAULT_DIRECT_TOOLS } from "../sunsama-mcp/constants";
import { isDirectTool, slimSchema, toolCatalog } from "../sunsama-mcp/tool-helpers";

describe("direct vs deferred Sunsama tools", () => {
  it("declares only the default core set unless configured", () => {
    const cfg = resolveConfig({});
    expect(isDirectTool(cfg, "create_task")).toBe(true);
    expect(isDirectTool(cfg, "create_weekly_objective")).toBe(false);
    expect([...(cfg.directTools as Set<string>)]).toEqual(DEFAULT_DIRECT_TOOLS);
    expect(isDirectTool(resolveConfig({ directTools: ["*"] }), "create_weekly_objective")).toBe(true);
    expect(isDirectTool(resolveConfig({ directTools: ["search_tasks"] }), "create_task")).toBe(false);
  });

  it("slimSchema drops oneOf integration schemas at every depth and keeps everything else", () => {
    const schema = {
      type: "object",
      required: ["title", "integration"],
      properties: {
        title: { type: "string" },
        integrationUrl: { type: "string" },
        integration: { oneOf: [{ type: "object" }, { type: "object" }] },
        subtasks: { type: "array", items: { type: "object", properties: { title: { type: "string" }, integration: { oneOf: [{}] } } } },
        other: { type: "object", properties: { integration: { type: "string" } } },
      },
    };
    const slim = slimSchema(schema) as any;
    expect(Object.keys(slim.properties)).toEqual(["title", "integrationUrl", "subtasks", "other"]);
    expect(slim.required).toEqual(["title"]);
    expect(Object.keys(slim.properties.subtasks.items.properties)).toEqual(["title"]);
    expect(slim.properties.other.properties.integration).toEqual({ type: "string" }); // not a provider oneOf
    expect(schema.properties.integration).toBeDefined(); // input untouched
  });

  it("toolCatalog gives one prefixed line per tool with the first sentence", () => {
    const text = toolCatalog([
      { name: "a", description: "Does A. More detail here.", inputSchema: {} },
      { name: "b", description: "x".repeat(200), inputSchema: {} },
    ], "tasks_");
    const lines = text.split("\n");
    expect(lines[0]).toBe("tasks_a: Does A.");
    expect(lines[1].length).toBeLessThan(130);
  });
});
