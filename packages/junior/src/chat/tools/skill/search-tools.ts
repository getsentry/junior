import { Type } from "@sinclair/typebox";
import type { Skill } from "@/chat/skills";
import { tool } from "@/chat/tools/definition";
import type { McpToolManager } from "@/chat/mcp/tool-manager";
import { toExposedToolSummary } from "@/chat/tools/skill/mcp-tool-summary";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export function createSearchToolsTool(
  mcpToolManager: McpToolManager,
  getActiveSkills: () => Skill[],
) {
  return tool({
    description:
      "Search active MCP tools exposed by the currently loaded skills. Use when you need to rediscover or filter active tools.",
    inputSchema: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          description:
            "Search query for matching MCP tool names or descriptions.",
        }),
        provider: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Optional MCP provider filter, for example notion or sentry.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_LIMIT,
            description: "Maximum number of matching tools to return.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async ({ query, provider, limit }) => {
      const results = mcpToolManager
        .searchTools(getActiveSkills(), query, {
          ...(provider ? { provider } : {}),
          limit: limit ?? DEFAULT_LIMIT,
        })
        .map(toExposedToolSummary);

      return {
        ok: true,
        query,
        ...(provider ? { provider } : {}),
        result_count: results.length,
        results,
      };
    },
  });
}
