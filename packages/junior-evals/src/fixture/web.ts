/**
 * The public web for the agent test fixture.
 *
 * The `webFetch` tool reads public web pages, which change and can be down.
 * This module records each response with vitest-evals replay and answers
 * later requests from the recording. The recordings are in
 * `.vitest-evals/recordings/webFetch/`. `pnpm evals:record` records them
 * again.
 *
 * The `webSearch` tool asks a search provider through the AI Gateway. This
 * module always answers that request itself, so no test reaches the real
 * provider. A search finds nothing unless the test calls
 * `mockWebSearchResults()`.
 */
import { randomUUID } from "node:crypto";
import { bypass, http, HttpResponse } from "msw";
import { onTestFinished } from "vitest";
import { executeWithReplay } from "vitest-evals/replay";
import { USER_AGENT } from "@/chat/tools/web/constants";
import { mswServer } from "@junior-tests/msw/server";

/** One recorded response. A redirect has a `location` and no body. */
type RecordedResponse = {
  body: string;
  /** `base64` for a body that is not text, such as an image. */
  bodyEncoding: "base64" | "utf8";
  contentType: string | null;
  location: string | null;
  status: number;
};

/** Install the web page replay for the current test. */
export function installWebReplay(): void {
  mswServer.use(
    http.get("*", async ({ request }) => {
      // Only `webFetch` sends this user agent. Other requests go to the
      // handlers below.
      if (request.headers.get("user-agent") !== USER_AGENT) return undefined;
      const { result } = await executeWithReplay({
        toolName: "webFetch",
        args: { url: request.url },
        context: null,
        // `webFetch` follows redirects itself, so each one is its own request.
        execute: async (): Promise<RecordedResponse> => {
          const response = await fetch(bypass(request, { redirect: "manual" }));
          const contentType = response.headers.get("content-type");
          const isText = /^text\/|json|xml/i.test(contentType ?? "");
          return {
            body: isText
              ? await response.text()
              : Buffer.from(await response.arrayBuffer()).toString("base64"),
            bodyEncoding: isText ? "utf8" : "base64",
            contentType,
            location: response.headers.get("location"),
            status: response.status,
          };
        },
        replay: { version: "web-page-v1" },
      });
      return new HttpResponse(
        result.bodyEncoding === "base64"
          ? Buffer.from(result.body, "base64")
          : result.body,
        {
          status: result.status,
          headers: {
            ...(result.contentType
              ? { "content-type": result.contentType }
              : undefined),
            ...(result.location ? { location: result.location } : undefined),
          },
        },
      );
    }),
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
