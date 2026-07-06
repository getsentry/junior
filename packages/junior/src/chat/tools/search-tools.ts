import type { AnyToolDefinition } from "@/chat/tools/definition";
import { z } from "zod";
import { effectiveToolExposure } from "@/chat/tool-exposure";
import { summarizeInputSchema } from "@/chat/tool-support/schema-summary";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

export const SEARCH_TOOLS_NAME = "searchTools";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim();
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
): string[] {
  const entries = Object.entries(tools).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (!normalize(query)) {
    return entries.map(([name]) => name);
  }

  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return entries
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

/** Build the agent-visible catalog tool summary returned by searchTools. */
function toolMetadata(name: string, definition: AnyToolDefinition) {
  return {
    tool_name: name,
    description: definition.description,
    exposure: effectiveToolExposure(definition),
    source: definition.identity
      ? {
          type: "plugin" as const,
          id: definition.identity.id,
          name: definition.identity.name,
          plugin: definition.identity.plugin,
        }
      : { type: "core" as const },
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
  return zodTool({
    description:
      "Search the executable tool catalog. Use this to discover exact tool names, owners, schemas, and call notes before calling executeTool.",
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
    outputSchema: juniorToolResultSchema,
    execute: async ({ query, max_results }) => {
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
      const matches = searchCatalogTools(catalogTools, query ?? "").slice(
        0,
        maxResults,
      );
      const data = {
        query: query ?? null,
        total_catalog_tools: Object.keys(catalogTools).length,
        returned_tools: matches.length,
        tools: matches.map((name) => toolMetadata(name, catalogTools[name]!)),
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
