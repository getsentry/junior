import { tool } from "@/chat/tools/definition";
import { generateText } from "ai";
import { createGatewayProvider } from "@ai-sdk/gateway";
import { Type } from "@sinclair/typebox";
import { withTimeout } from "@/chat/tools/web/network";
import { logException } from "@/chat/logging";

const SEARCH_TIMEOUT_MS = 60_000;
const MAX_RESULTS = 5;
const DEFAULT_SEARCH_MODEL = "xai/grok-4-fast-reasoning";
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
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) {
      return `web search failed: ${message}`;
    }
  }

  return "web search failed";
}

function isNonRetryableSearchFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("missing ai gateway credentials") ||
    normalized.includes("authentication failed")
  );
}

function isTimeoutSearchFailure(message: string): boolean {
  return /timed out/i.test(message);
}

export function createWebSearchTool() {
  return tool({
    description:
      "Search public web sources and return top snippets/URLs. Use when you need discovery or source candidates. Do not use when the user already provided a specific URL to inspect.",
    inputSchema: Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: 500,
        description: "Search query.",
      }),
      max_results: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_RESULTS,
          description: "Max results to return.",
        }),
      ),
    }),
    execute: async ({ query, max_results }) => {
      const maxResults = max_results ?? 3;
      try {
        const model =
          process.env.AI_WEB_SEARCH_MODEL ??
          process.env.AI_FAST_MODEL ??
          process.env.AI_MODEL ??
          DEFAULT_SEARCH_MODEL;

        // AI SDK Gateway already reads AI_GATEWAY_API_KEY or ambient Vercel
        // OIDC itself, so this path should not pass auth explicitly.
        const provider = createGatewayProvider();
        const response = await withTimeout(
          (async () => {
            try {
              return await generateText({
                model: provider.chat(model),
                prompt: query,
                tools: {
                  [SEARCH_TOOL_NAME]: provider.tools.parallelSearch({
                    mode: "agentic",
                    maxResults,
                  }),
                },
                toolChoice: {
                  type: "tool",
                  toolName: SEARCH_TOOL_NAME,
                },
              });
            } catch (error) {
              throw new Error(formatSearchFailure(error));
            }
          })(),
          SEARCH_TIMEOUT_MS,
          "webSearch",
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
        const timeout = isTimeoutSearchFailure(message);
        const retryable = !isNonRetryableSearchFailure(message);
        // Report real failures (timeouts, gateway errors) to Sentry so we can
        // see when the search tool is broken. Auth misconfiguration is a known
        // environment issue, not a runtime bug — skip it.
        if (retryable) {
          logException(
            error,
            "web_search_failed",
            {},
            {
              "gen_ai.tool.name": "webSearch",
              "app.web_search.timeout": timeout,
              "app.web_search.query": query,
            },
            message,
          );
        }
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
