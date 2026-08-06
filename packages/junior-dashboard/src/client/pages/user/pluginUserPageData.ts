import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import {
  pluginUserPageContentSchema,
  type PluginUserPageContent,
  type PluginUserPageLink,
} from "@sentry/junior-plugin-api";

import { deleteDashboardResource, fetchDashboardJson } from "../../http";
import { useDebouncedSearchParam } from "../../searchParams";

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
  const [searchText, setSearchText, searchQuery] = useDebouncedSearchParam();

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
      // Drop detail caches first so a forgotten permalink is not refetched
      // while list/summary queries refresh under the same plugin prefix.
      queryClient.removeQueries({
        queryKey: [
          "dashboard",
          "plugin-user-page",
          context.pluginName,
          "record",
        ],
      });
      await queryClient.invalidateQueries({
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
