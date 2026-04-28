import { Type } from "@sinclair/typebox";
import type {
  ManagedMcpToolDescriptor,
  McpToolManager,
} from "@/chat/mcp/tool-manager";
import type { Skill } from "@/chat/skills";
import { tool } from "@/chat/tools/definition";
import { toExposedToolSummary } from "@/chat/tools/skill/mcp-tool-summary";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;

interface RankedTool {
  tool: ManagedMcpToolDescriptor;
  score: number;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim();
}

function searchableToolText(toolDef: ManagedMcpToolDescriptor): string {
  return normalize(
    [
      toolDef.name,
      toolDef.rawName,
      toolDef.title,
      toolDef.provider,
      toolDef.description,
      JSON.stringify(toolDef.parameters),
      JSON.stringify(toolDef.outputSchema),
      JSON.stringify(toolDef.annotations),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function scoreTool(toolDef: ManagedMcpToolDescriptor, query: string): number {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedName = normalize(toolDef.name);
  const normalizedRawName = normalize(toolDef.rawName);
  const text = searchableToolText(toolDef);
  let score = 0;

  if (
    normalizedName === normalizedQuery ||
    normalizedRawName === normalizedQuery
  ) {
    score += 100;
  }
  if (normalizedName.includes(normalizedQuery)) {
    score += 50;
  }
  if (normalizedRawName.includes(normalizedQuery)) {
    score += 45;
  }
  if (text.includes(normalizedQuery)) {
    score += 25;
  }

  for (const term of normalizedQuery.split(/\s+/).filter(Boolean)) {
    if (normalizedName.includes(term)) {
      score += 12;
    }
    if (normalizedRawName.includes(term)) {
      score += 10;
    }
    if (text.includes(term)) {
      score += 4;
    }
  }

  return score;
}

function searchMcpCatalog(
  tools: ManagedMcpToolDescriptor[],
  query: string,
): ManagedMcpToolDescriptor[] {
  if (!normalize(query)) {
    return [...tools].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  return tools
    .map(
      (toolDef): RankedTool => ({
        tool: toolDef,
        score: scoreTool(toolDef, query),
      }),
    )
    .filter((ranked) => ranked.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.tool.name.localeCompare(right.tool.name);
    })
    .map((ranked) => ranked.tool);
}

/** Create the progressive MCP catalog search tool used before callMcpTool. */
export function createSearchMcpToolsTool(
  mcpToolManager: McpToolManager,
  getActiveSkills: () => Skill[],
) {
  return tool({
    description:
      "List or search active MCP tools and return full descriptors, including input/output schemas and annotations. Use after loadSkill when choosing a provider tool or when callMcpTool arguments are unclear.",
    inputSchema: Type.Object(
      {
        query: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Optional search terms describing the MCP tool or arguments needed.",
          }),
        ),
        provider: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Optional provider name to list or search within.",
          }),
        ),
        max_results: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_RESULTS,
            description: "Maximum matching tool descriptors to return.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async ({ query, provider, max_results }) => {
      const catalog = mcpToolManager.getActiveToolCatalog(
        getActiveSkills(),
        provider ? { provider } : {},
      );
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
      const matches = searchMcpCatalog(catalog, query ?? "").slice(
        0,
        maxResults,
      );
      return {
        query: query ?? null,
        provider: provider ?? null,
        total_active_tools: catalog.length,
        returned_tools: matches.length,
        tools: matches.map(toExposedToolSummary),
      };
    },
  });
}
