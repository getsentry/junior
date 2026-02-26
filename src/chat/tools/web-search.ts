import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import { withTimeout } from "@/chat/tools/network";

const SEARCH_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 5;

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function createWebSearchTool() {
  return tool({
    description: "Search public web sources and return top result snippets.",
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
      const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const html = await withTimeout(
        fetch(url, { headers: { "user-agent": "junior-bot/1.0" } }).then((response) => response.text()),
        SEARCH_TIMEOUT_MS,
        "web_search"
      );

      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let match: RegExpExecArray | null;
      while ((match = re.exec(html)) && results.length < maxResults) {
        results.push({
          url: decodeHtml(match[1]),
          title: decodeHtml(match[2].replace(/<[^>]+>/g, "").trim()),
          snippet: decodeHtml(match[3].replace(/<[^>]+>/g, "").trim())
        });
      }

      return {
        ok: true,
        query,
        result_count: results.length,
        results
      };
    }
  });
}
