import type { AnyToolDefinition } from "@/chat/tools/definition";
import { z } from "zod";
import { effectiveToolExposure } from "@/chat/tool-exposure";
import { summarizeInputSchema } from "@/chat/tool-support/schema-summary";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

export const SEARCH_TOOLS_NAME = "searchTools";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;
const MODEL_VISIBLE_DESCRIPTION_CAP = 180;

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
    exposure: z.enum(["direct", "deferred", "modelOnly", "hidden"]),
    source: z.string().optional(),
    input_schema: z.unknown(),
    input_schema_summary: z.string(),
    call_notes: z.array(z.string()),
    annotations: z.record(z.string(), z.unknown()),
  })
  .strict();

const searchToolsOutputSchema = juniorToolResultSchema
  .extend({
    query: z.string().nullable(),
    source: z.string().nullable(),
    sources: z.array(searchToolsSourceSchema),
    total_catalog_tools: z.number().int().nonnegative(),
    total_eligible_tools: z.number().int().nonnegative(),
    total_matches: z.number().int().nonnegative(),
    returned_tools: z.number().int().nonnegative(),
    tools: z.array(searchToolsToolSchema),
  })
  .strict();

interface SourceSummary {
  id: string;
  description: string;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim();
}

/** Summarize catalog descriptions before rendering them into model-visible data. */
export function summarizeModelVisibleDescription(description: string): string {
  const paragraph =
    description
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  const normalized = paragraph.replace(/\s+/g, " ").trim();
  if (normalized.length <= MODEL_VISIBLE_DESCRIPTION_CAP) {
    return normalized;
  }
  return `${normalized.slice(0, MODEL_VISIBLE_DESCRIPTION_CAP - 3).trimEnd()}...`;
}

function schemaText(schema: unknown): string {
  try {
    return JSON.stringify(schema);
  } catch {
    return "";
  }
}

function searchableToolText(
  name: string,
  definition: AnyToolDefinition,
): string {
  return normalize(
    [
      name,
      definition.identity?.id,
      definition.identity?.name,
      definition.identity?.plugin,
      definition.source?.id,
      definition.source?.description,
      definition.description,
      definition.promptSnippet,
      ...(definition.promptGuidelines ?? []),
      schemaText(definition.inputSchema),
      JSON.stringify(definition.annotations ?? {}),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function searchCatalogTools(
  tools: Record<string, AnyToolDefinition>,
  query: string,
  source: string | null,
): string[] {
  const entries = Object.entries(tools).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const sourceEntries = source
    ? entries.filter(([, definition]) => definition.source?.id === source)
    : entries;
  if (!normalize(query)) {
    return sourceEntries.map(([name]) => name);
  }

  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return sourceEntries
    .filter(([name, definition]) => {
      const text = searchableToolText(name, definition);
      return terms.every((term) => text.includes(term));
    })
    .map(([name]) => name);
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
  const intro =
    "Search the executable tool catalog. Deferred tools are grouped by source; use searchTools with source to inspect one source, then executeTool with the exact returned tool_name.";
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
) {
  return {
    tool_name: name,
    description: summarizeModelVisibleDescription(definition.description),
    exposure: effectiveToolExposure(definition),
    ...(includeSource && definition.source
      ? { source: definition.source.id }
      : {}),
    input_schema: definition.inputSchema,
    input_schema_summary: summarizeInputSchema(
      definition.inputSchema as Record<string, unknown>,
    ),
    call_notes: callNotes(definition),
    annotations: definition.annotations ?? {},
  };
}

/** Create the model-visible search tool for the executable tool catalog. */
export function createSearchToolsTool(
  catalogTools: Record<string, AnyToolDefinition>,
) {
  const knownSources = sourceSummaries(catalogTools);
  return zodTool({
    description: renderSearchToolsDescription(knownSources),
    annotations: { readOnlyHint: true, destructiveHint: false },
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
    execute: async ({ query, source, max_results }) => {
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
      const requestedSource = source ?? null;
      const sourceExists =
        requestedSource === null ||
        knownSources.some((candidate) => candidate.id === requestedSource);
      const allMatches = sourceExists
        ? searchCatalogTools(catalogTools, query ?? "", requestedSource)
        : [];
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
        ? searchCatalogTools(catalogTools, "", requestedSource).length
        : 0;
      const includePerToolSource = requestedSource === null;
      const renderedTools = matches.map((name) =>
        toolMetadata(name, catalogTools[name]!, includePerToolSource),
      );
      const data = {
        query: query ?? null,
        source: requestedSource,
        sources,
        total_catalog_tools: Object.keys(catalogTools).length,
        total_eligible_tools: totalEligibleTools,
        total_matches: allMatches.length,
        returned_tools: renderedTools.length,
        tools: renderedTools,
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
