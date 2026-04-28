import { describe, expect, it, vi } from "vitest";
import type { McpToolManager } from "@/chat/mcp/tool-manager";
import type { Skill } from "@/chat/skills";
import { createSearchMcpToolsTool } from "@/chat/tools/skill/search-mcp-tools";

const activeSkill: Skill = {
  name: "demo",
  description: "Demo skill",
  skillPath: "/tmp/demo",
  pluginProvider: "demo",
  body: "instructions",
};

describe("searchMcpTools", () => {
  function buildManager() {
    return {
      getActiveToolCatalog: vi.fn(
        (_skills: Skill[], _options?: { provider?: string }) => [
          {
            name: "mcp__demo__create_issue",
            rawName: "create_issue",
            provider: "demo",
            description: "Create an issue",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string", description: "Issue title" },
              },
              required: ["title"],
            },
            outputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
            annotations: { destructiveHint: true },
          },
          {
            name: "mcp__demo__list_projects",
            rawName: "list_projects",
            provider: "demo",
            description: "List projects",
            parameters: { type: "object", properties: {} },
          },
        ],
      ),
    } as unknown as McpToolManager;
  }

  it("returns focused MCP descriptors with input and output schemas", async () => {
    const manager = buildManager();
    const searchMcpTools = createSearchMcpToolsTool(manager, () => [
      activeSkill,
    ]);

    const result = (await searchMcpTools.execute!(
      { query: "issue title", max_results: 1 },
      {},
    )) as {
      tools: Array<{
        tool_name: string;
        input_schema: Record<string, unknown>;
        output_schema?: Record<string, unknown>;
        annotations?: Record<string, unknown>;
      }>;
    };

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({
      tool_name: "mcp__demo__create_issue",
      input_schema: {
        properties: {
          title: { type: "string", description: "Issue title" },
        },
      },
      output_schema: {
        properties: { id: { type: "string" } },
      },
      annotations: { destructiveHint: true },
    });
  });

  it("lists active provider tools without a query", async () => {
    const manager = buildManager();
    const searchMcpTools = createSearchMcpToolsTool(manager, () => [
      activeSkill,
    ]);

    const result = (await searchMcpTools.execute!(
      { provider: "demo", max_results: 10 },
      {},
    )) as {
      query: string | null;
      provider: string | null;
      tools: Array<{ tool_name: string }>;
    };

    expect(result).toMatchObject({
      query: null,
      provider: "demo",
      tools: [
        { tool_name: "mcp__demo__create_issue" },
        { tool_name: "mcp__demo__list_projects" },
      ],
    });
    expect(manager.getActiveToolCatalog).toHaveBeenCalledWith([activeSkill], {
      provider: "demo",
    });
  });
});
