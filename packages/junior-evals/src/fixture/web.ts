/**
 * The web search provider for the agent test fixture.
 *
 * The `webSearch` tool asks a search provider through the AI Gateway. This
 * module always answers that request itself, so no test reaches the real
 * provider. A search finds nothing unless the test calls
 * `mockWebSearchResults()`.
 *
 * The pages that the `webFetch` tool reads go to Roach, which
 * replays them. See `src/recording-rules.ts`. A test can answer the pages of
 * some sites itself with `mockWebSites()`.
 */
import { randomUUID } from "node:crypto";
import { bypass, http, HttpResponse } from "msw";
import { onTestFinished } from "vitest";
import { USER_AGENT } from "@/chat/tools/web/constants";
import { mswServer } from "@junior-tests/msw/server";

let mockedSites: Record<string, string> = {};

/** The host of a URL without `www.`, so both forms are the same site. */
function siteHost(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

/**
 * Answer every `webFetch` read on each host with its HTML in this test, for
 * any path, with or without `www.`. Give each host one real page. Other hosts
 * still go to Roach.
 */
export function mockWebSites(pages: Record<string, string>): void {
  mockedSites = pages;
  onTestFinished(() => {
    mockedSites = {};
  });
}

/** Send the pages that `webFetch` reads to Roach. */
export function installWebReplay(): void {
  mswServer.use(
    http.get("*", ({ request }) => {
      // Only `webFetch` sends this user agent.
      if (request.headers.get("user-agent") !== USER_AGENT) return undefined;
      const page = mockedSites[siteHost(new URL(request.url))];
      if (page !== undefined) {
        return new Response(page, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      // `webFetch` uses `node:https`, which does not use the proxy. `fetch`
      // uses the proxy dispatcher of the test. `webFetch` follows redirects
      // itself, so each redirect is its own request.
      return fetch(bypass(request, { redirect: "manual" }));
    }),
  );
}

/** One result of the mocked search provider. */
export interface WebSearchResult {
  excerpt: string;
  title: string;
  url: string;
}

const SEARCH_REQUEST_URL = "https://ai-gateway.vercel.sh/v4/ai/language-model";
const SEARCH_TOOL_ID = "gateway.parallel_search";

type SearchResults = WebSearchResult[] | ((query: string) => WebSearchResult[]);

let searchResults: SearchResults = [];

/**
 * Set the results that the mocked search provider returns in this test. A
 * list answers every query. A function gets the query and returns its
 * results, so each search can find the pages that it asks for.
 *
 * The fixture always mocks the search provider. This function does not turn
 * the mock on. Without it, `webSearch` finds nothing.
 */
export function mockWebSearchResults(results: SearchResults): void {
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
    prompt?: Array<{ content?: unknown }>;
    tools?: Array<{
      args?: { maxResults?: number };
      id?: string;
      name?: string;
    }>;
  };
  const tool = payload.tools?.find((entry) => entry.id === SEARCH_TOOL_ID);
  if (!tool) return undefined;
  // `webSearch` sends the query as the text of the prompt.
  const query = (payload.prompt ?? [])
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .flatMap((part: { text?: unknown }) =>
      typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
  const results =
    typeof searchResults === "function" ? searchResults(query) : searchResults;
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
          results: results
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
