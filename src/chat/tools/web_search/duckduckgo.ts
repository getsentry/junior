import { FETCH_TIMEOUT_MS, USER_AGENT } from "@/chat/tools/constants";
import { withTimeout } from "@/chat/tools/network";
import type { SearchResponse } from "@/chat/tools/web_search/types";

export async function duckDuckGoSearch(query: string, limit: number): Promise<SearchResponse> {
  const url = `https://api.duckduckgo.com/?format=json&no_redirect=1&no_html=1&skip_disambig=1&q=${encodeURIComponent(query)}`;
  const response = await withTimeout(
    fetch(url, {
      headers: {
        "user-agent": USER_AGENT
      }
    }),
    FETCH_TIMEOUT_MS,
    "search"
  );

  if (!response.ok) {
    throw new Error(`search request failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    Heading?: string;
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };

  const results: Array<{ title: string; url: string; snippet: string }> = [];

  if (payload.AbstractText && payload.AbstractURL) {
    results.push({
      title: payload.Heading || query,
      url: payload.AbstractURL,
      snippet: payload.AbstractText
    });
  }

  for (const topic of payload.RelatedTopics ?? []) {
    if (results.length >= limit) break;
    if (topic.Text && topic.FirstURL) {
      results.push({
        title: topic.Text.split(" - ")[0],
        url: topic.FirstURL,
        snippet: topic.Text
      });
    }
    for (const nested of topic.Topics ?? []) {
      if (results.length >= limit) break;
      if (nested.Text && nested.FirstURL) {
        results.push({
          title: nested.Text.split(" - ")[0],
          url: nested.FirstURL,
          snippet: nested.Text
        });
      }
    }
  }

  return { query, results: results.slice(0, limit) };
}
