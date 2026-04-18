import { tool } from "@/chat/tools/definition";
import { logException } from "@/chat/logging";
import { generateText, stepCountIs } from "ai";
import { createGatewayProvider } from "@ai-sdk/gateway";
import { Type } from "@sinclair/typebox";
import { withTimeout } from "@/chat/tools/web/network";

/** Default allows gateway + model time for agentic parallel search; override with AI_WEB_SEARCH_TIMEOUT_MS. */
const DEFAULT_SEARCH_TIMEOUT_MS = 45_000;
const MAX_RESULTS = 5;
const DEFAULT_SEARCH_MODEL = "xai/grok-4-fast-reasoning";
const SEARCH_TOOL_NAME = "parallelSearch";
/** Gateway may surface this id on tool parts from some providers. */
const SEARCH_TOOL_ALIASES = new Set([
  SEARCH_TOOL_NAME,
  "gateway.parallel_search",
]);

function resolveSearchTimeoutMs(): number {
  const raw = process.env.AI_WEB_SEARCH_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SEARCH_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SEARCH_TIMEOUT_MS;
  }
  return parsed;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isParallelSearchToolName(name: unknown): boolean {
  return typeof name === "string" && SEARCH_TOOL_ALIASES.has(name);
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

type ParallelSearchSuccessOutput = {
  results?: Array<Record<string, unknown>>;
};

type ParallelSearchErrorOutput = {
  error: string;
  message: string;
};

function isParallelSearchErrorOutput(
  output: unknown,
): output is ParallelSearchErrorOutput {
  if (output === null || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  return typeof o.error === "string" && typeof o.message === "string";
}

/**
 * Collects gateway parallel search hits and errors from every `generateText` step.
 * Provider-executed tools can surface results on non-final steps; the AI SDK also
 * represents gateway failures as structured `{ error, message }` outputs.
 */
function collectParallelSearchOutcome(
  steps: ReadonlyArray<{ toolResults?: unknown }>,
  maxResults: number,
): {
  results: Array<{ title: string; url: string; snippet: string }>;
  toolFailureMessage?: string;
  sawParallelSearchPart: boolean;
} {
  const parsedResults: Array<{ title: string; url: string; snippet: string }> =
    [];

  let toolFailureMessage: string | undefined;
  let sawParallelSearchPart = false;

  for (const step of steps) {
    const toolResults = step.toolResults;
    if (!Array.isArray(toolResults)) continue;

    for (const part of toolResults) {
      if (part === null || typeof part !== "object") continue;
      const tr = part as {
        type?: string;
        toolName?: string;
        output?: unknown;
        error?: unknown;
      };

      if (!isParallelSearchToolName(tr.toolName)) continue;
      sawParallelSearchPart = true;

      if (tr.type === "tool-error") {
        toolFailureMessage = errorMessageFromUnknown(tr.error);
        continue;
      }

      if (tr.type !== "tool-result") continue;

      const output = tr.output;
      if (isParallelSearchErrorOutput(output)) {
        toolFailureMessage = `${output.error}: ${output.message}`;
        continue;
      }

      const success = output as ParallelSearchSuccessOutput;
      const results = Array.isArray(success.results) ? success.results : [];

      for (const result of results) {
        const url = asString(result.url);
        if (!url) continue;
        parsedResults.push({
          title: asString(result.title) ?? url,
          url,
          snippet: asString(result.excerpt) ?? asString(result.snippet) ?? "",
        });

        if (parsedResults.length >= maxResults) {
          return {
            results: parsedResults,
            toolFailureMessage,
            sawParallelSearchPart,
          };
        }
      }
    }
  }

  return { results: parsedResults, toolFailureMessage, sawParallelSearchPart };
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
      const searchTimeoutMs = resolveSearchTimeoutMs();
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
                // Provider-executed parallel search often needs a second model step
                // after the gateway returns tool results (default stopWhen is one step).
                stopWhen: stepCountIs(2),
              });
            } catch (error) {
              throw new Error(formatSearchFailure(error));
            }
          })(),
          searchTimeoutMs,
          "webSearch",
        );

        const { results, toolFailureMessage, sawParallelSearchPart } =
          collectParallelSearchOutcome(response.steps, maxResults);

        if (results.length > 0) {
          return {
            ok: true,
            model,
            query,
            result_count: results.length,
            results,
          };
        }

        const emptyExplanation = toolFailureMessage
          ? toolFailureMessage
          : sawParallelSearchPart
            ? "parallel search returned no URL results"
            : "web search did not return parallel search results";
        const err = new Error(emptyExplanation);
        logException(
          err,
          "web_search_no_results",
          {},
          {
            "app.tool.name": "webSearch",
          },
        );
        return {
          ok: false,
          model,
          query,
          result_count: 0,
          results: [],
          error: formatSearchFailure(err),
          timeout: false,
          retryable: !isNonRetryableSearchFailure(emptyExplanation),
        };
      } catch (error) {
        const message = formatSearchFailure(error);
        logException(
          error instanceof Error ? error : new Error(message),
          "web_search_failed",
          {},
          { "app.tool.name": "webSearch" },
        );
        return {
          ok: false,
          query,
          result_count: 0,
          results: [],
          error: message,
          timeout: isTimeoutSearchFailure(message),
          retryable: !isNonRetryableSearchFailure(message),
        };
      }
    },
  });
}
