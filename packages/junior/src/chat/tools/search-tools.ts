import type { AnyToolDefinition } from "@/chat/tool-support/definition";
import * as z from "zod";
import type { ConversationModelCost } from "@/chat/core-model";
import { setSpanAttributes } from "@/chat/logging";
import { effectiveToolExposure } from "@/chat/tool-exposure";
import {
  PARAMS_PREVIEW_HINT,
  searchCatalogTools,
  summarizeModelVisibleDescription,
} from "@/chat/tool-support/catalog-search";
import { rerankSearchCandidates } from "@/chat/tool-support/catalog-search-rerank";
import { summarizeInputSchema } from "@/chat/tool-support/schema-summary";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;

const NO_MATCH_NOTE =
  "No tool fits this query. Try other words, or search with only source to list its tools.";

const searchToolsSourceSchema = z
  .object({
    id: z.string(),
    description: z.string(),
  })
  .strict();

const searchToolsToolSchema = z
  .object({
    tool_name: z.string(),
    description: z.string(),
    source: z.string().optional(),
    // The best match of a query has its full schema. Other results have
    // `params` only, so one search does not pay for every schema.
    input_schema: z.unknown().optional(),
    params: z.string().optional(),
    call_notes: z.array(z.string()).optional(),
  })
  .strict();

const searchToolsOutputSchema = juniorToolOutputSchema
  .extend({
    query: z.string().nullable(),
    source: z.string().nullable(),
    sources: z.array(searchToolsSourceSchema),
    total_catalog_tools: z.number().int().nonnegative(),
    total_eligible_tools: z.number().int().nonnegative(),
    total_matches: z.number().int().nonnegative(),
    returned_tools: z.number().int().nonnegative(),
    execution_tool: z.literal("executeTool"),
    tools: z.array(searchToolsToolSchema),
    note: z.string().optional(),
  })
  .strict();

interface SourceSummary {
  id: string;
  description: string;
}

/** List every catalog tool in a source, or in all sources, by name. */
function listCatalogTools(
  tools: Record<string, AnyToolDefinition>,
  source: string | null,
): string[] {
  return Object.entries(tools)
    .filter(([, definition]) =>
      source ? definition.source?.id === source : true,
    )
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}

function callNotes(definition: AnyToolDefinition): string[] {
  return [
    ...(definition.promptSnippet?.trim()
      ? [definition.promptSnippet.trim()]
      : []),
    ...(definition.promptGuidelines
      ?.map((guideline) => guideline.trim())
      .filter(Boolean) ?? []),
  ];
}

function sourceSummaries(
  tools: Record<string, AnyToolDefinition>,
): SourceSummary[] {
  const sources = new Map<string, SourceSummary>();
  for (const definition of Object.values(tools)) {
    if (!definition.source) {
      continue;
    }
    sources.set(definition.source.id, {
      id: definition.source.id,
      description: summarizeModelVisibleDescription(
        definition.source.description,
      ),
    });
  }
  return [...sources.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function selectedSourceSummaries(
  tools: Record<string, AnyToolDefinition>,
  matches: string[],
  requestedSource: string | null,
  knownSources: SourceSummary[],
): SourceSummary[] {
  if (requestedSource) {
    return knownSources.filter((source) => source.id === requestedSource);
  }
  const matchedSourceIds = new Set(
    matches
      .map((name) => tools[name]?.source?.id)
      .filter((source): source is string => Boolean(source)),
  );
  return knownSources.filter((source) => matchedSourceIds.has(source.id));
}

function renderSearchToolsDescription(knownSources: SourceSummary[]): string {
  const intro = `Search the executable tool catalog. Deferred tools are grouped by source. List a source, or search with a query. The first result of a query has its full input_schema. ${PARAMS_PREVIEW_HINT} Then call the tool with executeTool and its exact tool_name.`;
  if (knownSources.length === 0) {
    return intro;
  }
  return [
    intro,
    "Available sources:",
    ...knownSources.map((source) => `- ${source.id}: ${source.description}`),
  ].join("\n");
}

/** Build the agent-visible catalog tool summary returned by searchTools. */
function toolMetadata(
  name: string,
  definition: AnyToolDefinition,
  includeSource: boolean,
  includeSchema: boolean,
) {
  const notes = callNotes(definition);
  return {
    tool_name: name,
    description: summarizeModelVisibleDescription(definition.description),
    ...(includeSource && definition.source
      ? { source: definition.source.id }
      : undefined),
    ...(includeSchema
      ? { input_schema: definition.inputSchema }
      : { params: summarizeInputSchema(definition.inputSchema) }),
    ...(notes.length > 0 ? { call_notes: notes } : undefined),
  };
}

/**
 * Create the model-visible search tool for the executable tool catalog.
 * Direct tools stay out of results: the model already has their schemas.
 *
 * @runBuilt searchTools
 */
export function createSearchToolsTool(
  allCatalogTools: Record<string, AnyToolDefinition>,
  /** The Conversation that pays for a rerank model call. */
  rerankCost: ConversationModelCost,
) {
  const catalogTools = Object.fromEntries(
    Object.entries(allCatalogTools).filter(
      ([, definition]) => effectiveToolExposure(definition) !== "direct",
    ),
  );
  const knownSources = sourceSummaries(catalogTools);
  return zodTool({
    description: renderSearchToolsDescription(knownSources),
    exposure: "modelOnly",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        query: z
          .string()
          .nullable()
          .describe(
            "Optional search terms describing the tool, owner, action, or arguments needed. Empty string lists catalog tools.",
          )
          .optional(),
        source: z
          .string()
          .nullable()
          .describe(
            "Optional source id to search within, such as a plugin source returned in sources.",
          )
          .optional(),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .nullable()
          .describe("Maximum matching catalog tool descriptors to return.")
          .optional(),
      })
      .strict(),
    outputSchema: searchToolsOutputSchema,
    privateTraceResult: (result) => ({
      tools: result.tools.map(
        ({ tool_name, description, input_schema, params }) => ({
          tool_name,
          description,
          input_schema,
          params,
        }),
      ),
    }),
    execute: async ({ query, source, max_results }, { signal }) => {
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
      const requestedSource = source ?? null;
      const sourceExists =
        requestedSource === null ||
        knownSources.some((candidate) => candidate.id === requestedSource);
      const hasQuery = Boolean(query?.trim());
      const search = !sourceExists
        ? { matches: [], unclearCandidates: [] }
        : hasQuery
          ? searchCatalogTools(catalogTools, query!, requestedSource)
          : {
              matches: listCatalogTools(catalogTools, requestedSource),
              unclearCandidates: [],
            };
      let allMatches = search.matches;
      if (search.unclearCandidates.length > 0) {
        allMatches =
          (await rerankSearchCandidates({
            query: query!,
            cost: rerankCost,
            candidates: search.unclearCandidates.map((name) => ({
              name,
              source: catalogTools[name]!.source?.id,
              description: summarizeModelVisibleDescription(
                catalogTools[name]!.description,
              ),
            })),
            signal,
          })) ?? allMatches;
      } else if (hasQuery) {
        setSpanAttributes({ "app.tool_search.rerank.ran": false });
      }
      const matches = allMatches.slice(0, maxResults);
      const sources = !sourceExists
        ? knownSources
        : (query ?? "").trim()
          ? selectedSourceSummaries(
              catalogTools,
              matches,
              requestedSource,
              knownSources,
            )
          : requestedSource
            ? knownSources.filter(
                (candidate) => candidate.id === requestedSource,
              )
            : knownSources;
      const totalEligibleTools = sourceExists
        ? listCatalogTools(catalogTools, requestedSource).length
        : 0;
      const includePerToolSource = requestedSource === null;
      // A source listing is not ranked, so it shows no full schema.
      const renderedTools = matches.map((name, index) =>
        toolMetadata(
          name,
          catalogTools[name]!,
          includePerToolSource,
          hasQuery && index === 0,
        ),
      );
      const result: z.infer<typeof searchToolsOutputSchema> = {
        query: query ?? null,
        source: requestedSource,
        sources,
        total_catalog_tools: Object.keys(catalogTools).length,
        total_eligible_tools: totalEligibleTools,
        total_matches: allMatches.length,
        returned_tools: renderedTools.length,
        execution_tool: "executeTool" as const,
        tools: renderedTools,
      };
      if (allMatches.length === 0 && (query ?? "").trim()) {
        result.note = NO_MATCH_NOTE;
      }
      return result;
    },
  });
}
