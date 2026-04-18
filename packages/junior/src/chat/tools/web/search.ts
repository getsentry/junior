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

type StepPart = {
  type: string;
  toolName?: string;
  output?: unknown;
  error?: unknown;
};

type SearchHit = { title: string; url: string; snippet: string };

/** Failures often appear only on the step `content` array (not duplicated in `toolResults`). */
function parallelSearchGatewayFailureFromContent(
  content: StepPart[],
): string | undefined {
  for (const part of content) {
    if (part.toolName !== SEARCH_TOOL_NAME) {
      continue;
    }
    if (part.type === "tool-error") {
      const detail = formatGatewayToolFailure(part.error);
      if (detail) {
        return detail;
      }
    }
    if (
      part.type === "tool-result" &&
      isGatewayParallelSearchErrorOutput(part.output)
    ) {
      const o = part.output;
      return `${o.error}: ${o.message}`;
    }
  }
  return undefined;
}

function collectParallelSearchHits(
  content: StepPart[],
  toolResults: StepPart[],
  maxResults: number,
): { results: SearchHit[]; sawToolResult: boolean } {
  const results: SearchHit[] = [];
  let sawToolResult = false;
  for (const part of [...content, ...toolResults]) {
    if (part.type !== "tool-result" || part.toolName !== SEARCH_TOOL_NAME) {
      continue;
    }
    sawToolResult = true;
    const output = part.output;
    if (isGatewayParallelSearchErrorOutput(output)) {
      continue;
    }
    const rows = Array.isArray(
      (output as { results?: unknown } | undefined)?.results,
    )
      ? ((output as { results: unknown[] }).results as Array<
          Record<string, unknown>
        >)
      : [];
    for (const row of rows) {
      const url = asString(row.url);
      if (!url) {
        continue;
      }
      results.push({
        title: asString(row.title) ?? url,
        url,
        snippet: asString(row.excerpt) ?? asString(row.snippet) ?? "",
      });
      if (results.length >= maxResults) {
        return { results, sawToolResult };
      }
    }
  }
  return { results, sawToolResult };
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

        const gatewayFailureMessage = parallelSearchGatewayFailureFromContent(
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

        const { results, sawToolResult } = collectParallelSearchHits(
          response.content,
          response.toolResults,
          maxResults,
        );

        if (results.length === 0 && !sawToolResult) {
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
