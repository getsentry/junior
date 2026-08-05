import { describe, expect, it, vi } from "vitest";
import { createSearchMcpToolsTool } from "@/chat/tools/skill/search-mcp-tools";

describe("searchMcpTools", () => {
  function buildManager() {
    return {
      activateProvider: vi.fn(async () => true),
      getAvailableProviderCatalog: vi.fn(() => [
        {
          provider: "demo",
          description: "Demo provider",
          active: true,
        },
        {
          provider: "linear",
          description: "Linear issues",
          active: false,
        },
      ]),
      getActiveToolCatalog: vi.fn((_options?: { provider?: string }) => [
        {
          name: "mcp__demo__create_issue",
          rawName: "create_issue",
          provider: "demo",
          description: "Create an issue",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Issue title" },
              labels: {
                type: "array",
                items: { type: "string" },
                description: "Issue labels",
              },
              metadata: {
                type: "object",
                description: "Issue metadata",
              },
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
      ]),
    };
  }

  it("returns focused MCP descriptors with input and output schemas", async () => {
    const manager = buildManager();
    const searchMcpTools = createSearchMcpToolsTool(manager);

    const result = (await searchMcpTools.execute!(
      { query: "issue title", max_results: 1 },
      {},
    )) as {
      query: string | null;
      provider: string | null;
      total_active_tools: number;
      returned_tools: number;
      execution_tool: string;
      available_providers: Array<{
        provider: string;
        description: string;
        active: boolean;
      }>;
      tools: Array<{
        tool_name: string;
        input_schema: Record<string, unknown>;
        output_schema?: Record<string, unknown>;
        annotations?: Record<string, unknown>;
      }>;
    };

    expect(result).toMatchObject({ execution_tool: "callMcpTool" });
    expect(result).not.toHaveProperty("data");
    const privateTraceResult = searchMcpTools.privateTraceResult?.(result);
    expect(privateTraceResult).toEqual({
      total_active_tools: result.total_active_tools,
      returned_tools: result.returned_tools,
      execution_tool: result.execution_tool,
      available_providers: result.available_providers,
      tools: result.tools,
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({
      tool_name: "mcp__demo__create_issue",
      input_schema: {
        properties: {
          title: { type: "string", description: "Issue title" },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Issue labels",
          },
          metadata: {
            type: "object",
            description: "Issue metadata",
          },
        },
        required: ["title"],
      },
      output_schema: {
        properties: { id: { type: "string" } },
      },
      annotations: { destructiveHint: true },
    });
  });

  it("lists active provider tools without a query", async () => {
    const manager = buildManager();
    const searchMcpTools = createSearchMcpToolsTool(manager);

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
        {
          tool_name: "mcp__demo__create_issue",
          input_schema: {
            required: ["title"],
          },
        },
        {
          tool_name: "mcp__demo__list_projects",
          input_schema: {
            properties: {},
          },
        },
      ],
    });
    expect(manager.getActiveToolCatalog).toHaveBeenCalledWith({
      provider: "demo",
    });
    expect(manager.getAvailableProviderCatalog).not.toHaveBeenCalled();
  });

  it("returns configured provider matches without connecting when provider is omitted", async () => {
    const manager = buildManager();
    const searchMcpTools = createSearchMcpToolsTool(manager);

    const result = (await searchMcpTools.execute!(
      { query: "linear", max_results: 10 },
      {},
    )) as {
      available_providers: Array<{
        provider: string;
        description: string;
        active: boolean;
      }>;
      tools: Array<{ tool_name: string }>;
    };

    expect(result.available_providers).toEqual([
      {
        provider: "linear",
        description: "Linear issues",
        active: false,
      },
    ]);
    expect(result.tools).toEqual([]);
    expect(manager.activateProvider).not.toHaveBeenCalled();
  });
});
