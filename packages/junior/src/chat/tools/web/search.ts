import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { searchWeb, type ConversationModelCost } from "@/chat/core-model";
import { withTimeout } from "@/chat/tool-support/web/network";
import type { WebSearchToolDeps } from "@/chat/tool-support/types";

const SEARCH_TIMEOUT_MS = 60_000;
const MAX_RESULTS = 5;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseSearchResults(
  outputs: unknown[],
  maxResults: number,
): Array<{ title: string; url: string; snippet: string }> {
  const parsedResults: Array<{ title: string; url: string; snippet: string }> =
    [];

  for (const output of outputs) {
    const results = (output as { results?: unknown } | undefined)?.results;
    if (!Array.isArray(results)) continue;

    for (const result of results as Array<Record<string, unknown>>) {
      const url = asString(result["url"]);
      if (!url) continue;
      parsedResults.push({
        title: asString(result["title"]) ?? url,
        url,
        snippet:
          asString(result["excerpt"]) ?? asString(result["snippet"]) ?? "",
      });

      if (parsedResults.length >= maxResults) {
        return parsedResults;
      }
    }
  }

  return parsedResults;
}

export const webSearchToolDefinition = zodToolDefinition({
  description:
    "Search public web sources and return top snippets/URLs. Use when you need discovery or source candidates. Do not use when the user already provided a specific URL to inspect.",
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  inputSchema: z.object({
    query: z.string().min(1).max(500).describe("Search query."),
    max_results: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_RESULTS)
      .describe("Max results to return.")
      .optional(),
  }),
  outputSchema: juniorToolOutputSchema,
});

export function createWebSearchTool(
  modelId: string,
  cost: ConversationModelCost,
  override?: WebSearchToolDeps,
) {
  return zodTool({
    ...webSearchToolDefinition,
    execute: async ({ query, max_results }) => {
      if (override?.execute) {
        return override.execute({ query, max_results });
      }

      const maxResults = max_results ?? 3;
      // Keep web search pinned to a provider-tool capable model instead of
      // inheriting the main turn model.
      const controller = new AbortController();
      const { outputs } = await withTimeout(
        searchWeb({
          operation: "web_search",
          cost,
          modelId,
          query,
          maxResults,
          signal: controller.signal,
        }),
        SEARCH_TIMEOUT_MS,
        "webSearch",
        { onTimeout: () => controller.abort() },
      );

      const results = parseSearchResults(outputs, maxResults);
      return {
        model: modelId,
        query,
        result_count: results.length,
        results,
      };
    },
  });
}
