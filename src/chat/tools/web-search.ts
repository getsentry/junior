import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import { withTimeout } from "@/chat/tools/network";
import { getGatewayApiKey } from "@/chat/pi/client";

const SEARCH_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 5;
const DEFAULT_SEARCH_MODEL = "xai/grok-4-fast-reasoning";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const PARALLEL_SEARCH_TOOL_ID = "vercel/parallel-search";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseGatewaySearchResults(payload: unknown, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const choices = Array.isArray((payload as { choices?: unknown }).choices)
    ? ((payload as { choices?: unknown }).choices as Array<Record<string, unknown>>)
    : [];
  const message = choices[0]?.message as Record<string, unknown> | undefined;
  const toolCalls = Array.isArray(message?.tool_calls) ? (message?.tool_calls as Array<Record<string, unknown>>) : [];
  const parsedResults: Array<{ title: string; url: string; snippet: string }> = [];

  for (const toolCall of toolCalls) {
    const fn = toolCall.function as Record<string, unknown> | undefined;
    const rawArguments = asString(fn?.arguments);
    if (!rawArguments) continue;

    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(rawArguments) as unknown;
    } catch {
      continue;
    }

    const results = Array.isArray((parsedArguments as { results?: unknown }).results)
      ? ((parsedArguments as { results: unknown[] }).results as Array<Record<string, unknown>>)
      : [];

    for (const result of results) {
      const url = asString(result.url);
      if (!url) continue;
      parsedResults.push({
        title: asString(result.title) ?? url,
        url,
        snippet: asString(result.content) ?? asString(result.snippet) ?? ""
      });

      if (parsedResults.length >= maxResults) {
        return parsedResults;
      }
    }
  }

  return parsedResults;
}

function parseGatewaySearchError(status: number, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return `web search failed: ${status}`;
  }

  try {
    const payload = JSON.parse(trimmed) as { error?: { message?: string } };
    const message = payload.error?.message?.trim();
    if (message) {
      return `web search failed: ${status} ${message}`;
    }
  } catch {
    // Fall through to return raw body when response is not JSON.
  }

  return `web search failed: ${status} ${trimmed}`;
}

export function createWebSearchTool() {
  return tool({
    description:
      "Search public web sources and return top snippets/URLs. Use when you need discovery or source candidates. Do not use when the user already provided a specific URL to inspect.",
    inputSchema: Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: 500,
        description: "Search query."
      }),
      max_results: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_RESULTS,
          description: "Max results to return."
        })
      )
    }),
    execute: async ({ query, max_results }) => {
      const maxResults = max_results ?? 3;
      const apiKey = getGatewayApiKey();
      if (!apiKey) {
        throw new Error("Missing AI gateway credentials (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)");
      }
      const model =
        process.env.AI_WEB_SEARCH_MODEL ??
        process.env.AI_ROUTER_MODEL ??
        process.env.AI_MODEL ??
        DEFAULT_SEARCH_MODEL;

      const payload = await withTimeout(
        (async () => {
          const response = await fetch(GATEWAY_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: query }],
              tools: [
                {
                  type: "tool",
                  tool: {
                    type: "provider-defined",
                    id: PARALLEL_SEARCH_TOOL_ID,
                    args: {
                      query,
                      maxResults
                    }
                  }
                }
              ],
              tool_choice: "required"
            })
          });

          if (!response.ok) {
            throw new Error(parseGatewaySearchError(response.status, await response.text()));
          }

          return (await response.json()) as unknown;
        })(),
        SEARCH_TIMEOUT_MS,
        "webSearch"
      );
      const results = parseGatewaySearchResults(payload, maxResults);

      return {
        ok: true,
        model,
        query,
        result_count: results.length,
        results
      };
    }
  });
}
