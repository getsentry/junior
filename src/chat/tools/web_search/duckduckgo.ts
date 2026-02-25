import { FETCH_TIMEOUT_MS, USER_AGENT } from "@/chat/tools/constants";
import { withTimeout } from "@/chat/tools/network";
import type { SearchResponse } from "@/chat/tools/web_search/types";

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function extractDuckDuckGoTarget(href: string): string | null {
  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    const encodedTarget = parsed.searchParams.get("uddg");
    if (encodedTarget) {
      return decodeURIComponent(encodedTarget);
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export function parseDuckDuckGoHtml(html: string, limit: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const linkPattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch: RegExpExecArray | null = null;

  while ((linkMatch = linkPattern.exec(html))) {
    if (results.length >= limit) break;
    const candidateUrl = extractDuckDuckGoTarget(linkMatch[1]);
    if (!candidateUrl) continue;

    const searchWindow = html.slice(linkMatch.index, linkMatch.index + 1200);
    const snippetMatch = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(searchWindow);
    const title = decodeHtml(stripTags(linkMatch[2]));
    const snippet = decodeHtml(stripTags(snippetMatch?.[1] ?? ""));

    if (!title) continue;
    results.push({
      title,
      url: candidateUrl,
      snippet
    });
  }

  return results.slice(0, limit);
}

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

  if (results.length > 0) {
    return { query, results: results.slice(0, limit) };
  }

  const htmlResponse = await withTimeout(
    fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "user-agent": USER_AGENT
      }
    }),
    FETCH_TIMEOUT_MS,
    "search"
  );

  if (!htmlResponse.ok) {
    throw new Error(`search request failed: ${htmlResponse.status}`);
  }

  const html = await htmlResponse.text();
  return {
    query,
    results: parseDuckDuckGoHtml(html, limit)
  };
}
