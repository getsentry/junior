import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { generateText } from "ai";
import { createGatewayProvider } from "@ai-sdk/gateway";
import { resolveGatewayCredential } from "@/chat/pi/gateway-auth";
import { withTimeout } from "@/chat/tools/web/network";
import type { WebSearchToolDeps } from "@/chat/tools/types";

const SEARCH_TIMEOUT_MS = 60_000;
const MAX_RESULTS = 5;
const SEARCH_TOOL_NAME = "parallelSearch";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseSearchResults(
  toolResults: unknown,
  maxResults: number,
): Array<{ title: string; url: string; snippet: string }> {
  const typedResults = Array.isArray(toolResults)
    ? (toolResults as Array<Record<string, unknown>>)
    : [];
  const parsedResults: Array<{ title: string; url: string; snippet: string }> =
    [];

  for (const toolResult of typedResults) {
    if (
      toolResult.type !== "tool-result" ||
      toolResult.toolName !== SEARCH_TOOL_NAME
    ) {
      continue;
    }

    const output = (toolResult as { output?: unknown }).output as
      | { results?: unknown }
      | undefined;
    const results = Array.isArray(output?.results)
      ? (output.results as Array<Record<string, unknown>>)
      : [];

    for (const result of results) {
      const url = asString(result.url);
      if (!url) continue;
      parsedResults.push({
        title: asString(result.title) ?? url,
        url,
        snippet: asString(result.excerpt) ?? asString(result.snippet) ?? "",
      });

      if (parsedResults.length >= maxResults) {
        return parsedResults;
      }
    }
  }

  return parsedResults;
}

export function createWebSearchTool(
  modelId: string,
  override?: WebSearchToolDeps,
) {
  return zodTool({
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
    execute: async ({ query, max_results }) => {
      if (override?.execute) {
        return override.execute({ query, max_results });
      }

      const maxResults = max_results ?? 3;
      // Keep web search pinned to a provider-tool capable model instead of
      // inheriting the main turn model.
      const controller = new AbortController();

      // Use Junior's shared resolver so OIDC wins over a leftover team API key.
      // createGatewayProvider() alone prefers AI_GATEWAY_API_KEY and would keep
      // project attribution as unknown while the key remains set.
      const credential = await resolveGatewayCredential();
      const provider = createGatewayProvider(
        credential ? { apiKey: credential.token } : {},
      );
      const response = await withTimeout(
        generateText({
          model: provider.chat(modelId),
          prompt: query,
          tools: {
            [SEARCH_TOOL_NAME]: provider.tools.parallelSearch({
              mode: "agentic",
              maxResults,
            }),
          },
          toolChoice: { type: "tool", toolName: SEARCH_TOOL_NAME },
          abortSignal: controller.signal,
        }),
        SEARCH_TIMEOUT_MS,
        "webSearch",
        { onTimeout: () => controller.abort() },
      );

      const results = parseSearchResults(response.toolResults, maxResults);
      return {
        model: modelId,
        query,
        result_count: results.length,
        results,
      };
    },
  });
}
