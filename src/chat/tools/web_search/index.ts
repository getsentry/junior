import { braveSearch } from "@/chat/tools/web_search/brave_search";
import { duckDuckGoSearch } from "@/chat/tools/web_search/duckduckgo";
import type { SearchResponse } from "@/chat/tools/web_search/types";

export async function webSearch(query: string, limit = 5): Promise<SearchResponse> {
  const safeLimit = Math.max(1, Math.min(limit, 10));
  const braveApiKey = process.env.BRAVE_SEARCH_API_KEY;

  if (braveApiKey) {
    try {
      const braveResults = await braveSearch(query, safeLimit, braveApiKey);
      if (braveResults.results.length > 0) {
        return braveResults;
      }
    } catch {
      // Fall back to DuckDuckGo when Brave fails.
    }
  }

  return duckDuckGoSearch(query, safeLimit);
}
