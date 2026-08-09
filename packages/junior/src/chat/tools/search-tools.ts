import type { AnyToolDefinition } from "@/chat/tools/definition";
import { z } from "zod";
import { effectiveToolExposure } from "@/chat/tool-exposure";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

export const SEARCH_TOOLS_NAME = "searchTools";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;
const MODEL_VISIBLE_DESCRIPTION_CAP = 180;
// Identity, descriptive guidance, and source/schema context respectively.
const SEARCH_FIELD_WEIGHTS = [8, 4, 1] as const;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "that",
  "the",
  "this",
  "to",
  "use",
  "we",
  "what",
  "when",
  "where",
  "which",
  "with",
  "you",
  "your",
]);

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
    call_notes: z.array(z.string()),
    annotations: z.record(z.string(), z.unknown()),
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
  })
  .strict();

interface SourceSummary {
  id: string;
  description: string;
}

interface SearchDocument {
  name: string;
  fields: [string[], string[], string[]];
}

function terms(value: string): string[] {
  const chunks = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  const result: string[] = [];
  for (const chunk of chunks) {
    result.push(chunk.toLowerCase());
    const expanded = chunk
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .toLowerCase()
      .split(/\s+/);
    if (expanded.length > 1) {
      result.push(...expanded);
    }
  }
  return result;
}

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      terms(query).filter(
        (term) => term.length >= 2 && !SEARCH_STOP_WORDS.has(term),
      ),
    ),
  ];
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

function searchableToolFields(
  name: string,
  definition: AnyToolDefinition,
): SearchDocument["fields"] {
  return [
    terms(
      [
        name,
        definition.identity?.id,
        definition.identity?.name,
        definition.identity?.plugin,
      ]
        .filter(Boolean)
        .join(" "),
    ),
    terms(
      [
        definition.description,
        definition.promptSnippet,
        ...(definition.promptGuidelines ?? []),
      ]
        .filter(Boolean)
        .join(" "),
    ),
    terms(
      [
        definition.source?.id,
        definition.source?.description,
        schemaText(definition.inputSchema),
        schemaText(definition.annotations ?? {}),
      ]
        .filter(Boolean)
        .join(" "),
    ),
  ];
}

function prepareSearchDocuments(
  tools: Record<string, AnyToolDefinition>,
  source: string | null,
): SearchDocument[] {
  return Object.entries(tools)
    .filter(([, definition]) =>
      source ? definition.source?.id === source : true,
    )
    .map(([name, definition]) => ({
      name,
      fields: searchableToolFields(name, definition),
    }));
}

function averageFieldLengths(documents: SearchDocument[]): number[] {
  if (documents.length === 0) {
    return SEARCH_FIELD_WEIGHTS.map(() => 0);
  }
  return SEARCH_FIELD_WEIGHTS.map(
    (_, fieldIndex) =>
      documents.reduce(
        (total, document) => total + document.fields[fieldIndex]!.length,
        0,
      ) / documents.length,
  );
}

function documentFrequencies(documents: SearchDocument[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const document of documents) {
    const uniqueTerms = new Set(document.fields.flat());
    for (const term of uniqueTerms) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  return frequencies;
}

function scoreSearchDocument(
  document: SearchDocument,
  query: string[],
  frequencies: Map<string, number>,
  documentCount: number,
  averageLengths: number[],
): number {
  return query.reduce((score, term) => {
    const documentFrequency = frequencies.get(term) ?? 0;
    if (documentFrequency === 0) {
      return score;
    }
    const weightedTermFrequency = document.fields.reduce(
      (weighted, field, fieldIndex) => {
        const termFrequency = field.filter(
          (candidate) => candidate === term,
        ).length;
        if (termFrequency === 0) {
          return weighted;
        }
        const averageLength = averageLengths[fieldIndex] ?? 0;
        const lengthRatio =
          averageLength === 0 ? 1 : field.length / averageLength;
        return (
          weighted +
          SEARCH_FIELD_WEIGHTS[fieldIndex]! *
            (termFrequency / (1 - BM25_B + BM25_B * lengthRatio))
        );
      },
      0,
    );
    if (weightedTermFrequency === 0) {
      return score;
    }
    const inverseDocumentFrequency = Math.log(
      1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
    );
    return (
      score +
      (inverseDocumentFrequency * weightedTermFrequency * (BM25_K1 + 1)) /
        (weightedTermFrequency + BM25_K1)
    );
  }, 0);
}

/** Rank matching catalog tools while keeping source filtering deterministic. */
function searchCatalogTools(
  tools: Record<string, AnyToolDefinition>,
  query: string,
  source: string | null,
): string[] {
  const documents = prepareSearchDocuments(tools, source);
  if (!query.trim()) {
    return documents
      .map(({ name }) => name)
      .sort((left, right) => left.localeCompare(right));
  }

  const searchTerms = queryTerms(query);
  if (searchTerms.length === 0) {
    return [];
  }
  const averageLengths = averageFieldLengths(documents);
  const frequencies = documentFrequencies(documents);
  return documents
    .map((document) => ({
      name: document.name,
      score: scoreSearchDocument(
        document,
        searchTerms,
        frequencies,
        documents.length,
        averageLengths,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.name.localeCompare(right.name),
    )
    .map(({ name }) => name);
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
      tools: result.tools.map(({ tool_name, description, input_schema }) => ({
        tool_name,
        description,
        input_schema,
      })),
    }),
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
      return {
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
    },
  });
}
