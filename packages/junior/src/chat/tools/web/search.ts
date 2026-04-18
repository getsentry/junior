import { tool } from "@/chat/tools/definition";
import { generateText } from "ai";
import { createGatewayProvider } from "@ai-sdk/gateway";
import { Type } from "@sinclair/typebox";
import { logException } from "@/chat/logging";
import { withTimeout } from "@/chat/tools/web/network";

const SEARCH_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 5;
const DEFAULT_SEARCH_MODEL = "xai/grok-4-fast-reasoning";
/** Client tool key must match the model/gateway tool name (see AI Gateway `gateway.parallel_search`). */
const SEARCH_TOOL_NAME = "parallel_search";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isGatewayParallelSearchErrorOutput(
  output: unknown,
): output is { error: string; message: string } {
  if (typeof output !== "object" || output === null) {
    return false;
  }
  const record = output as Record<string, unknown>;
  return (
    typeof record.error === "string" &&
    typeof record.message === "string" &&
    !("results" in record)
  );
}

function formatGatewayToolFailure(output: unknown): string | undefined {
  if (typeof output === "string" && output.trim()) {
    return output.trim();
  }
  if (isGatewayParallelSearchErrorOutput(output)) {
    return `${output.error}: ${output.message}`;
  }
  return undefined;
}

type GenerateTextStepContent = {
  type: string;
  toolName?: string;
  output?: unknown;
  error?: unknown;
};

/**
 * Provider-executed Parallel Search can surface failures as `tool-error` parts or
 * error-shaped `tool-result` outputs; both must be handled explicitly.
 */
function findParallelSearchGatewayFailure(
  content: GenerateTextStepContent[],
): string | undefined {
  for (const part of content) {
    if (part.toolName !== SEARCH_TOOL_NAME) {
      continue;
    }
    if (part.type === "tool-error") {
      const message = formatGatewayToolFailure(part.error);
      if (message) {
        return message;
      }
    }
    if (part.type === "tool-result") {
      const message = formatGatewayToolFailure(part.output);
      if (message && isGatewayParallelSearchErrorOutput(part.output)) {
        return message;
      }
    }
  }
  return undefined;
}

function hadParallelSearchToolResult(response: {
  content: GenerateTextStepContent[];
  toolResults: GenerateTextStepContent[];
}): boolean {
  for (const part of [...response.content, ...response.toolResults]) {
    if (part.type === "tool-result" && part.toolName === SEARCH_TOOL_NAME) {
      return true;
    }
  }
  return false;
}

function parseSearchResults(
  response: {
    content: GenerateTextStepContent[];
    toolResults: GenerateTextStepContent[];
  },
  maxResults: number,
): Array<{ title: string; url: string; snippet: string }> {
  const parsedResults: Array<{ title: string; url: string; snippet: string }> =
    [];

  const sources = [response.content, response.toolResults];
  for (const typedResults of sources) {
    for (const toolResult of typedResults) {
      if (
        toolResult.type !== "tool-result" ||
        toolResult.toolName !== SEARCH_TOOL_NAME
      ) {
        continue;
      }

      const output = toolResult.output as { results?: unknown } | undefined;
      if (isGatewayParallelSearchErrorOutput(output)) {
        continue;
      }

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

        const gatewayFailureMessage = findParallelSearchGatewayFailure(
          response.content,
        );
        if (gatewayFailureMessage) {
          const message = `web search failed: ${gatewayFailureMessage}`;
          logException(
            new Error(message),
            "web_search_gateway_failure",
            {},
            {
              "app.web_search.failure_kind": "gateway",
            },
            "AI Gateway parallel search returned an error",
          );
          return {
            ok: false,
            model,
            query,
            result_count: 0,
            results: [],
            error: message,
            timeout: false,
            retryable: !isNonRetryableSearchFailure(message),
          };
        }

        const results = parseSearchResults(response, maxResults);

        if (results.length === 0 && !hadParallelSearchToolResult(response)) {
          const message =
            "web search failed: Parallel Search returned no tool result (possible tool name mismatch or gateway issue)";
          logException(
            new Error(message),
            "web_search_silent_failure",
            {},
            {
              "app.web_search.failure_kind": "silent",
            },
            "Web search completed without a parallel_search tool result",
          );
          return {
            ok: false,
            model,
            query,
            result_count: 0,
            results: [],
            error: message,
            timeout: false,
            retryable: true,
          };
        }

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
        logException(
          error instanceof Error ? error : new Error(message),
          "web_search_failed",
          {},
          {
            "app.web_search.failure_kind": timeout ? "timeout" : "exception",
          },
          "Web search tool failed",
        );
        return {
          ok: false,
          query,
          result_count: 0,
          results: [],
          error: message,
          timeout,
          retryable: !isNonRetryableSearchFailure(message),
        };
      }
    },
  });
}
