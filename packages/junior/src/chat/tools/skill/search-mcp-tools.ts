import { Type } from "@sinclair/typebox";
import type { ManagedMcpToolDescriptor } from "@/chat/mcp/tool-manager";
import { tool } from "@/chat/tools/definition";
import { toExposedToolSummary } from "@/chat/tool-support/skill/mcp-tool-summary";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;

interface RankedTool {
  tool: ManagedMcpToolDescriptor;
  score: number;
}

interface ProviderSummary {
  provider: string;
  description: string;
  active: boolean;
}

interface SearchMcpToolManager {
  activateProvider(provider: string): Promise<boolean>;
  getActiveToolCatalog(options?: {
    provider?: string;
  }): ManagedMcpToolDescriptor[];
  getAvailableProviderCatalog(): ProviderSummary[];
}

interface RankedProvider {
  provider: ProviderSummary;
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

function scoreProvider(provider: ProviderSummary, query: string): number {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedName = normalize(provider.provider);
  const text = normalize([provider.provider, provider.description].join(" "));
  let score = 0;

  if (normalizedName === normalizedQuery) {
    score += 100;
  }
  if (normalizedName.includes(normalizedQuery)) {
    score += 50;
  }
  if (text.includes(normalizedQuery)) {
    score += 25;
  }

  for (const term of normalizedQuery.split(/\s+/).filter(Boolean)) {
    if (normalizedName.includes(term)) {
      score += 12;
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

function searchProviderCatalog(
  providers: ProviderSummary[],
  query: string,
): ProviderSummary[] {
  const sorted = [...providers].sort((left, right) =>
    left.provider.localeCompare(right.provider),
  );
  if (!normalize(query)) {
    return sorted;
  }

  return sorted
    .map(
      (provider): RankedProvider => ({
        provider,
        score: scoreProvider(provider, query),
      }),
    )
    .filter((ranked) => ranked.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.provider.provider.localeCompare(right.provider.provider);
    })
    .map((ranked) => ranked.provider);
}

/** Create the progressive MCP catalog search tool used before callMcpTool. */
export function createSearchMcpToolsTool(mcpToolManager: SearchMcpToolManager) {
  return tool({
    description:
      "List or search MCP providers and active MCP tools. When provider is supplied and not yet active, Junior connects to it on demand and returns tool descriptors including schemas. Without provider, returns active tools plus matching configured providers without connecting. Use when choosing a provider tool or when callMcpTool arguments are unclear.",
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
            description:
              "Optional provider name to list or search within. If configured but not yet connected, Junior activates it on demand.",
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
      if (provider) {
        await mcpToolManager.activateProvider(provider);
      }
      const catalog = mcpToolManager.getActiveToolCatalog(
        provider ? { provider } : {},
      );
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
      const matches = searchMcpCatalog(catalog, query ?? "").slice(
        0,
        maxResults,
      );
      const providers = provider
        ? []
        : searchProviderCatalog(
            mcpToolManager.getAvailableProviderCatalog(),
            query ?? "",
          ).slice(0, maxResults);
      return {
        query: query ?? null,
        provider: provider ?? null,
        total_active_tools: catalog.length,
        returned_tools: matches.length,
        available_providers: providers,
        tools: matches.map(toExposedToolSummary),
      };
    },
  });
}
