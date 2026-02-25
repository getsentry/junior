import { BRAVE_SEARCH_URL, FETCH_TIMEOUT_MS, USER_AGENT } from "@/chat/tools/constants";
import { withTimeout } from "@/chat/tools/network";
import type { SearchResponse } from "@/chat/tools/web_search/types";

export async function braveSearch(query: string, limit: number, apiKey: string): Promise<SearchResponse> {
  const response = await withTimeout(
    fetch(`${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${limit}`, {
      headers: {
        "user-agent": USER_AGENT,
        "x-subscription-token": apiKey,
        accept: "application/json"
      }
    }),
    FETCH_TIMEOUT_MS,
    "search"
  );

  if (!response.ok) {
    throw new Error(`brave search failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string; extra_snippets?: string[] }> };
  };

  const results = (payload.web?.results ?? [])
    .map((result) => {
      if (!result.url) return null;
      return {
        title: result.title ?? result.url,
        url: result.url,
        snippet: result.description ?? result.extra_snippets?.[0] ?? ""
      };
    })
    .filter((row): row is { title: string; url: string; snippet: string } => Boolean(row))
    .slice(0, limit);

  return { query, results };
}
