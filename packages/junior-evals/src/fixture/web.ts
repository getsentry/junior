/**
 * The web search provider for the agent test fixture.
 *
 * The `webSearch` tool asks a search provider through the AI Gateway. This
 * module always answers that request itself, so no test reaches the real
 * provider. A search finds nothing unless the test calls
 * `mockWebSearchResults()`.
 *
 * The pages that the `webFetch` tool reads go to the recording proxy, which
 * replays them. See `src/recording-rules.ts`.
 */
import { randomUUID } from "node:crypto";
import { http, HttpResponse, passthrough } from "msw";
import { onTestFinished } from "vitest";
import { USER_AGENT } from "@/chat/tools/web/constants";
import { mswServer } from "@junior-tests/msw/server";

/** Let the pages that `webFetch` reads reach the recording proxy. */
export function installWebPassthrough(): void {
  mswServer.use(
    http.get("*", ({ request }) =>
      // Only `webFetch` sends this user agent.
      request.headers.get("user-agent") === USER_AGENT
        ? passthrough()
        : undefined,
    ),
  );
}

/** One result of the mocked search provider. */
export interface WebSearchResult {
  excerpt: string;
  title: string;
  url: string;
}

const SEARCH_REQUEST_URL = "https://ai-gateway.vercel.sh/v3/ai/language-model";
const SEARCH_TOOL_ID = "gateway.parallel_search";

let searchResults: WebSearchResult[] = [];

/**
 * Set the results that the mocked search provider returns in this test, for
 * every query.
 *
 * The fixture always mocks the search provider. This function does not turn
 * the mock on. Without it, `webSearch` finds nothing.
 */
export function mockWebSearchResults(results: WebSearchResult[]): void {
  searchResults = results;
  onTestFinished(() => {
    searchResults = [];
  });
}

/**
 * Answer a `webSearch` request to the AI Gateway as the search provider
 * does. Return `undefined` for any other request.
 */
export async function answerWebSearch(
  request: Request,
): Promise<Response | undefined> {
  if (request.method !== "POST" || request.url !== SEARCH_REQUEST_URL) {
    return undefined;
  }
  const payload = (await request.clone().json()) as {
    tools?: Array<{
      args?: { maxResults?: number };
      id?: string;
      name?: string;
    }>;
  };
  const tool = payload.tools?.find((entry) => entry.id === SEARCH_TOOL_ID);
  if (!tool) return undefined;
  const toolCallId = `call_${randomUUID()}`;
  const tokens = { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 };
  return HttpResponse.json({
    content: [
      {
        type: "tool-call",
        toolCallId,
        toolName: tool.name,
        input: "{}",
        providerExecuted: true,
      },
      {
        type: "tool-result",
        toolCallId,
        toolName: tool.name,
        result: {
          results: searchResults
            .slice(0, tool.args?.maxResults)
            .map(({ excerpt, title, url }) => ({
              excerpts: [excerpt],
              title,
              url,
            })),
        },
        providerExecuted: true,
      },
    ],
    finishReason: { unified: "stop" },
    usage: {
      inputTokens: tokens,
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  });
}
