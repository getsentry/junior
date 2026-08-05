import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  pluginUserPageContentSchema,
  type PluginUserPageContent,
  type PluginUserPageLink,
} from "@sentry/junior-plugin-api";

import { deleteDashboardResource, fetchDashboardJson } from "../../http";

export type PluginUserPageRecord = PluginUserPageContent["records"][number];
export type PluginUserPageRecordAction = NonNullable<
  PluginUserPageRecord["actions"]
>[number];

/** Load one plugin page with shared search, pagination, and action behavior. */
export function usePluginUserPageData(page: PluginUserPageLink) {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const actionStarted = useRef(false);
  const filter = searchParams.get("filter")?.trim() ?? "";
  const searchQuery = searchParams.get("q")?.trim() ?? "";
  const [searchText, setSearchText] = useState(searchQuery);

  useEffect(() => setSearchText(searchQuery), [searchQuery]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const normalized = searchText.trim();
      if (normalized === searchQuery) return;
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (normalized) next.set("q", normalized);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchQuery, searchText, setSearchParams]);

  const query = useInfiniteQuery({
    initialPageParam: undefined as string | undefined,
    queryKey: [
      "dashboard",
      "plugin-user-page",
      page.pluginName,
      page.id,
      filter,
      searchQuery,
    ],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (filter) params.set("filter", filter);
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
    mutationFn: (recordAction: PluginUserPageRecordAction) =>
      deleteDashboardResource(recordAction.href),
    onMutate: () => ({ pluginName: page.pluginName }),
    onSuccess: async (_result, _recordAction, context) => {
      await queryClient.resetQueries({
        queryKey: ["dashboard", "plugin-user-page", context.pluginName],
      });
    },
    onSettled: () => {
      actionStarted.current = false;
    },
  });

  function runAction(recordAction: PluginUserPageRecordAction) {
    if (actionStarted.current) return;
    if (
      recordAction.confirmation &&
      !window.confirm(recordAction.confirmation)
    ) {
      return;
    }
    actionStarted.current = true;
    action.mutate(recordAction);
  }

  function setFilter(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("filter", value);
    else next.delete("filter");
    setSearchParams(next, { replace: true });
  }

  return {
    action,
    content: query.data?.pages[0],
    filter,
    query,
    records,
    runAction,
    searchQuery,
    searchText,
    setFilter,
    setSearchText,
  };
}
