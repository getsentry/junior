import type { AnyToolDefinition } from "@/chat/tools/definition";
import * as z from "zod";
import { effectiveToolExposure } from "@/chat/tool-exposure";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

export const SEARCH_TOOLS_NAME = "searchTools";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;
const MODEL_VISIBLE_DESCRIPTION_CAP = 180;
// Identity, descriptive guidance, and source/parameter context respectively.
const SEARCH_FIELD_WEIGHTS = [8, 4, 1] as const;
// Drop matches that score below this share of the best match, so a query
// returns the tools that fit it instead of every tool that shares one word.
const MIN_RELATIVE_SCORE = 0.3;
const BM25_K1 = 1.2;
// Length normalization per field. Long tool descriptions add usage guidance,
// not more topics, so they get a weaker length penalty than the other fields.
const BM25_B = [0.75, 0.3, 0.75] as const;

// A synonym match counts for less than an exact match, so a tool that uses
// the query's own word still ranks first.
const SYNONYM_WEIGHT = 0.6;

// Common action words that tools and queries use for the same action. These
// are generic English, so they also apply to MCP and plugin tools.
const SEARCH_SYNONYM_GROUPS = [
  ["get", "fetch", "read", "view", "show", "retrieve", "look"],
  ["update", "edit", "change", "modify", "set", "rename"],
  ["create", "add", "new", "make", "file", "write"],
  ["delete", "remove", "archive", "forget", "drop", "discard"],
  ["search", "find", "query", "lookup", "look"],
  ["list", "show", "all", "enumerate"],
  ["comment", "reply", "respond"],
  ["stop", "cancel", "unwatch", "unsubscribe"],
  ["watch", "subscribe", "monitor", "follow"],
  ["save", "store", "remember", "memorize"],
];

// Short forms in queries that mean exactly the same as their long form. Only
// the query is expanded: most tools have a `repo` parameter, so expanding
// tool text would make "repository" match almost every tool.
const SEARCH_ABBREVIATIONS: Record<string, string[]> = {
  pr: ["pull", "request"],
  repo: ["repository"],
  msg: ["message"],
};

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

// Fold plurals, "-ed", "-ing", and a final "e", so "issues" matches
// "issue", "closed" matches "close", and "updating" matches "update". Both
// the query and the tool text use the same fold, so an odd stem such as
// "clos" still matches itself.
function stem(term: string): string {
  if (term.length <= 3) {
    return term;
  }
  let stemmed = term;
  if (stemmed.endsWith("ies")) {
    stemmed = `${stemmed.slice(0, -3)}y`;
  } else if (/(?:ss|us|ch|sh|x|z)es$/.test(stemmed)) {
    stemmed = stemmed.slice(0, -2);
  } else if (/[^sui]s$/.test(stemmed)) {
    stemmed = stemmed.slice(0, -1);
  }
  const verbSuffix = /(?:ed|ing)$/.exec(stemmed);
  if (verbSuffix && stemmed.length - verbSuffix[0].length >= 3) {
    stemmed = stemmed.slice(0, -verbSuffix[0].length);
  }
  if (stemmed.length > 3 && stemmed.endsWith("e")) {
    stemmed = stemmed.slice(0, -1);
  }
  return stemmed;
}

function rawTerms(value: string): string[] {
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

// Runs after stemming, so the long form is stemmed here to match tool text.
function expandAbbreviation(term: string): string[] {
  return SEARCH_ABBREVIATIONS[term]?.map(stem) ?? [term];
}

function terms(value: string): string[] {
  return rawTerms(value).map(stem);
}

const synonymsByTerm = new Map<string, Set<string>>();
for (const group of SEARCH_SYNONYM_GROUPS) {
  const stems = group.map(stem);
  for (const term of stems) {
    const synonyms = synonymsByTerm.get(term) ?? new Set<string>();
    for (const synonym of stems) {
      if (synonym !== term) {
        synonyms.add(synonym);
      }
    }
    synonymsByTerm.set(term, synonyms);
  }
}

// One query word with the weight that each matching tool word gets: 1 for
// the word itself and SYNONYM_WEIGHT for each synonym.
type QueryTerm = Map<string, number>;

function queryTerms(query: string): QueryTerm[] {
  const unique = [
    ...new Set(
      rawTerms(query)
        .filter((term) => term.length >= 2 && !SEARCH_STOP_WORDS.has(term))
        .map(stem)
        .flatMap(expandAbbreviation),
    ),
  ];
  return unique.map((term) => {
    const weights: QueryTerm = new Map();
    for (const synonym of synonymsByTerm.get(term) ?? []) {
      weights.set(synonym, SYNONYM_WEIGHT);
    }
    weights.set(term, 1);
    return weights;
  });
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

// Collect parameter names and descriptions. Raw schema JSON would add words
// such as "type", "string", and "properties" to every tool.
function parameterText(schema: unknown): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap(parameterText);
  }
  if (!schema || typeof schema !== "object") {
    return [];
  }
  const record = schema as Record<string, unknown>;
  const text: string[] = [];
  if (typeof record.description === "string") {
    text.push(record.description);
  }
  const properties = record.properties;
  if (properties && typeof properties === "object") {
    for (const [name, property] of Object.entries(properties)) {
      text.push(name, ...parameterText(property));
    }
  }
  for (const key of ["items", "anyOf", "oneOf", "allOf"]) {
    text.push(...parameterText(record[key]));
  }
  return text;
}

// A sentence that names another tool, such as "For issues, use
// github_commentOnIssue", tells the model about that other tool. Its words
// would make this tool match queries for the other tool, so ranking skips it.
function withoutToolReferences(
  text: string,
  name: string,
  toolNames: Set<string>,
): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter(
      (sentence) =>
        !(sentence.match(/[\w-]+/g) ?? []).some(
          (word) => word !== name && toolNames.has(word),
        ),
    )
    .join(" ");
}

function searchableToolFields(
  name: string,
  definition: AnyToolDefinition,
  toolNames: Set<string>,
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
      withoutToolReferences(
        [
          definition.description,
          definition.promptSnippet,
          ...(definition.promptGuidelines ?? []),
        ]
          .filter(Boolean)
          .join(" "),
        name,
        toolNames,
      ),
    ),
    // The source description is the same for every tool in the source, so
    // it only adds noise to ranking. Source filtering uses the source id.
    terms(
      [definition.source?.id, ...parameterText(definition.inputSchema)]
        .filter(Boolean)
        .join(" "),
    ),
  ];
}

function prepareSearchDocuments(
  tools: Record<string, AnyToolDefinition>,
  source: string | null,
): SearchDocument[] {
  const toolNames = new Set(Object.keys(tools));
  return Object.entries(tools)
    .filter(([, definition]) =>
      source ? definition.source?.id === source : true,
    )
    .map(([name, definition]) => ({
      name,
      fields: searchableToolFields(name, definition, toolNames),
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

interface ScoredQueryTerm {
  weights: QueryTerm;
  inverseDocumentFrequency: number;
}

// A query word and its synonyms share one document frequency: the count of
// tools that contain any of the words. A rare synonym then cannot outscore a
// common exact word.
function scoreQueryTerms(
  query: QueryTerm[],
  documents: SearchDocument[],
): ScoredQueryTerm[] {
  const documentTerms = documents.map(
    (document) => new Set(document.fields.flat()),
  );
  return query.map((weights) => {
    const documentFrequency = documentTerms.filter((terms) =>
      [...weights.keys()].some((term) => terms.has(term)),
    ).length;
    return {
      weights,
      inverseDocumentFrequency: Math.log(
        1 +
          (documents.length - documentFrequency + 0.5) /
            (documentFrequency + 0.5),
      ),
    };
  });
}

function weightedTermFrequency(
  document: SearchDocument,
  term: string,
  averageLengths: number[],
): number {
  return document.fields.reduce((weighted, field, fieldIndex) => {
    const termFrequency = field.filter(
      (candidate) => candidate === term,
    ).length;
    if (termFrequency === 0) {
      return weighted;
    }
    const averageLength = averageLengths[fieldIndex] ?? 0;
    const lengthRatio = averageLength === 0 ? 1 : field.length / averageLength;
    return (
      weighted +
      SEARCH_FIELD_WEIGHTS[fieldIndex]! *
        (termFrequency /
          (1 - BM25_B[fieldIndex]! + BM25_B[fieldIndex]! * lengthRatio))
    );
  }, 0);
}

// Each word gets its own BM25 saturation before its weight applies. Field
// weights make most matches saturate, so a weight applied to term frequency
// would make a synonym match score the same as an exact match.
function scoreSearchDocument(
  document: SearchDocument,
  query: ScoredQueryTerm[],
  averageLengths: number[],
): number {
  return query.reduce((score, { weights, inverseDocumentFrequency }) => {
    let best = 0;
    for (const [term, weight] of weights) {
      const frequency = weightedTermFrequency(document, term, averageLengths);
      best = Math.max(
        best,
        (weight * frequency * (BM25_K1 + 1)) / (frequency + BM25_K1),
      );
    }
    return score + inverseDocumentFrequency * best;
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
  const scoredTerms = scoreQueryTerms(searchTerms, documents);
  const averageLengths = averageFieldLengths(documents);
  const scored = documents
    .map((document) => ({
      name: document.name,
      score: scoreSearchDocument(document, scoredTerms, averageLengths),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.name.localeCompare(right.name),
    );
  const minScore = (scored[0]?.score ?? 0) * MIN_RELATIVE_SCORE;
  return scored
    .filter(({ score }) => score >= minScore)
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
    ...(includeSource && definition.source
      ? { source: definition.source.id }
      : undefined),
    input_schema: definition.inputSchema,
    call_notes: callNotes(definition),
    annotations: definition.annotations ?? {},
  };
}

/**
 * Create the model-visible search tool for the executable tool catalog.
 * Direct tools stay out of results: the model already has their schemas.
 */
export function createSearchToolsTool(
  allCatalogTools: Record<string, AnyToolDefinition>,
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
