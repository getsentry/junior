import { Type, type TSchema } from "@sinclair/typebox";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import { tool } from "@/chat/tools/definition";
import { effectiveToolExposure } from "@/chat/tool-exposure";

export const SEARCH_TOOLS_NAME = "searchTools";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim();
}

function schemaText(schema: TSchema): string {
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
      schemaText(definition.inputSchema),
      JSON.stringify(definition.annotations ?? {}),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function searchDeferredTools(
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
    annotations: definition.annotations ?? {},
  };
}

/** Create the model-visible search tool for deferred tool metadata. */
export function createSearchToolsTool(
  deferredTools: Record<string, AnyToolDefinition>,
) {
  return tool({
    description:
      "Search deferred tool metadata. Use when a specialized plugin or provider tool may exist but is not directly visible. Copy the exact returned tool_name into executeTool.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object(
      {
        query: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Optional search terms describing the tool, owner, action, or arguments needed.",
          }),
        ),
        max_results: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_RESULTS,
            description:
              "Maximum matching deferred tool descriptors to return.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async ({ query, max_results }) => {
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
      const matches = searchDeferredTools(deferredTools, query ?? "").slice(
        0,
        maxResults,
      );
      return {
        query: query ?? null,
        total_deferred_tools: Object.keys(deferredTools).length,
        returned_tools: matches.length,
        tools: matches.map((name) => toolMetadata(name, deferredTools[name]!)),
      };
    },
  });
}
