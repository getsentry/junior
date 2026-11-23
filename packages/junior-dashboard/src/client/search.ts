import {
  searchReportSchema,
  type SearchSource,
} from "@sentry/junior/api/schema";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { fetchDashboardJson } from "./http";

/**
 * Search the named sources with one `/api/search` read, while there is
 * text. Each source returns one group that matches word prefixes.
 */
export function useSearchData(
  search: string,
  sources: readonly SearchSource[],
) {
  const names = sources.join(",");
  return useQuery({
    enabled: Boolean(search),
    queryKey: ["dashboard", "search", names, search],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        searchReportSchema,
        `/api/search?${new URLSearchParams({ q: search, sources: names })}`,
        signal,
      ),
    placeholderData: keepPreviousData,
    retry: false,
  });
}
