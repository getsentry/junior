import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { generateText } from "ai";
import { createGatewayProvider } from "@ai-sdk/gateway";
import { getModel } from "@earendil-works/pi-ai";
import { withTimeout } from "@/chat/tools/web/network";
import { logException } from "@/chat/logging";
import type { WebSearchToolDeps } from "@/chat/tools/types";

const SEARCH_TIMEOUT_MS = 60_000;
const MAX_RESULTS = 5;
const DEFAULT_SEARCH_MODEL = getModel("vercel-ai-gateway", "openai/gpt-5.4").id;
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

function formatSearchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message ? `web search failed: ${message}` : "web search failed";
}

function isAuthFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("missing ai gateway credentials") ||
    normalized.includes("authentication failed")
  );
}

export function createWebSearchTool(override?: WebSearchToolDeps) {
  return zodTool({
    description:
      "Search public web sources and return top snippets/URLs. Use when you need discovery or source candidates. Do not use when the user already provided a specific URL to inspect.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
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
    execute: async ({ query, max_results }) => {
      if (override?.execute) {
        return override.execute({ query, max_results });
      }

      const maxResults = max_results ?? 3;
      // Keep web search pinned to a provider-tool capable model instead of
      // inheriting the main turn model.
      const model = process.env.AI_WEB_SEARCH_MODEL ?? DEFAULT_SEARCH_MODEL;
      const controller = new AbortController();

      try {
        // AI SDK Gateway reads AI_GATEWAY_API_KEY or ambient Vercel OIDC
        // itself; no explicit auth needed here.
        const provider = createGatewayProvider();
        const response = await withTimeout(
          generateText({
            model: provider.chat(model),
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
          ok: true,
          model,
          query,
          result_count: results.length,
          results,
        };
      } catch (error) {
        const message = formatSearchFailure(error);
        const timeout = /timed out/i.test(message);
        const retryable = !isAuthFailure(message);
        // Every ok:false path surfaces to Sentry. The tool swallows the
        // exception for the model, so without an explicit capture the
        // failure is otherwise invisible to us.
        logException(
          error,
          "web_search_failed",
          {},
          {
            "gen_ai.tool.name": "webSearch",
            "app.web_search.timeout": timeout,
            "app.web_search.retryable": retryable,
            "app.web_search.query": query,
          },
          message,
        );
        return {
          ok: false,
          query,
          result_count: 0,
          results: [],
          error: message,
          timeout,
          retryable,
        };
      }
    },
  });
}
