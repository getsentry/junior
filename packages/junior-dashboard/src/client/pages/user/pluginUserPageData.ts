import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import {
  pluginUserPageContentSchema,
  type PluginUserPageContent,
  type PluginUserPageLink,
} from "@sentry/junior-plugin-api";

import { deleteDashboardResource, fetchDashboardJson } from "../../http";

export type PluginUserPageRecord = PluginUserPageContent["records"][number];

/** Load one plugin page with shared search, pagination, and action behavior. */
export function usePluginUserPageData(page: PluginUserPageLink) {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const searchQuery = searchParams.get("q")?.trim() ?? "";
  const [searchText, setSearchText] = useState(searchQuery);

  useEffect(() => setSearchText(searchQuery), [searchQuery]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const normalized = searchText.trim();
      if (normalized === searchQuery) return;
      setSearchParams(normalized ? { q: normalized } : {}, { replace: true });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchQuery, searchText, setSearchParams]);

  const queryKey = useMemo(
    () => [
      "dashboard",
      "plugin-user-page",
      page.pluginName,
      page.id,
      searchQuery,
    ],
    [page.id, page.pluginName, searchQuery],
  );
  const query = useInfiniteQuery({
    initialPageParam: undefined as string | undefined,
    queryKey,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (searchQuery) params.set("q", searchQuery);
      if (pageParam) params.set("cursor", pageParam);
      const search = params.toString();
      return fetchDashboardJson(
        pluginUserPageContentSchema,
        `/api/user-pages/${encodeURIComponent(page.pluginName)}/${encodeURIComponent(page.id)}${search ? `?${search}` : ""}`,
        signal,
      );
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    placeholderData: (previousData) => previousData,
    retry: false,
  });
  const records = useMemo(
    () => [
      ...new Map(
        (query.data?.pages ?? [])
          .flatMap((content) => content.records)
          .map((record) => [record.id, record]),
      ).values(),
    ],
    [query.data?.pages],
  );
  const action = useMutation({
    mutationFn: async (
      recordAction: NonNullable<PluginUserPageRecord["actions"]>[number],
    ) => {
      if (
        recordAction.confirmation &&
        !window.confirm(recordAction.confirmation)
      ) {
        return false;
      }
      await deleteDashboardResource(recordAction.href);
      return true;
    },
    onSuccess: async (changed) => {
      if (changed) await queryClient.resetQueries({ queryKey });
    },
  });

  return {
    action,
    content: query.data?.pages[0],
    query,
    records,
    searchQuery,
    searchText,
    setSearchText,
  };
}
