import type { ManagedMcpToolDescriptor } from "@/chat/mcp/tool-manager";
import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { toExposedToolSummary } from "@/chat/tool-support/skill/mcp-tool-summary";
import { zodTool } from "@/chat/tool-support/zod-tool";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;

const providerSummarySchema = z
  .object({
    provider: z.string(),
    description: z.string(),
    active: z.boolean(),
  })
  .strict();

const mcpCallExampleSchema = z
  .object({
    tool_name: z.string(),
    arguments: z.record(z.string(), z.string()),
  })
  .strict();

const exposedToolSummarySchema = z
  .object({
    tool_name: z.string(),
    mcp_tool_name: z.string(),
    provider: z.string(),
    title: z.string().optional(),
    description: z.string(),
    signature: z.string(),
    call: mcpCallExampleSchema,
    input_schema: z.record(z.string(), z.unknown()),
    input_schema_summary: z.string(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const searchMcpToolsOutputSchema = juniorToolResultSchema
  .extend({
    query: z.string().nullable(),
    provider: z.string().nullable(),
    total_active_tools: z.number().int().nonnegative(),
    returned_tools: z.number().int().nonnegative(),
    execution_tool: z.literal("callMcpTool"),
    execution_example: mcpCallExampleSchema,
    available_providers: z.array(providerSummarySchema),
    tools: z.array(exposedToolSummarySchema),
  })
  .strict();

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
  return zodTool({
    description:
      "List or search MCP providers and active MCP tools. When provider is supplied and not yet active, Junior connects to it on demand and returns tool descriptors including schemas. Without provider, returns active tools plus matching configured providers without connecting. Use when choosing a provider tool or when callMcpTool arguments are unclear.",
    inputSchema: z
      .object({
        query: z
          .string()
          .min(1)
          .describe(
            "Optional search terms describing the MCP tool or arguments needed.",
          )
          .optional(),
        provider: z
          .string()
          .min(1)
          .describe(
            "Optional provider name to list or search within. If configured but not yet connected, Junior activates it on demand.",
          )
          .optional(),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .describe("Maximum matching tool descriptors to return.")
          .optional(),
      })
      .strict(),
    outputSchema: searchMcpToolsOutputSchema,
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
      const data = {
        query: query ?? null,
        provider: provider ?? null,
        total_active_tools: catalog.length,
        returned_tools: matches.length,
        execution_tool: "callMcpTool" as const,
        execution_example: {
          tool_name: "<returned tool_name>",
          arguments: {
            "<argument>": "<value from input_schema>",
          },
        },
        available_providers: providers,
        tools: matches.map(toExposedToolSummary),
      };
      return {
        ok: true,
        status: "success" as const,
        data,
        ...data,
      };
    },
  });
}
