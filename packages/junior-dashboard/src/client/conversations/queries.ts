import { useEffect, useMemo } from "react";
import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ConversationDetailReport,
  ConversationEventPage,
  ConversationFeed,
} from "@sentry/junior/api/schema";
import {
  archiveConversationResponseSchema,
  conversationDetailReportSchema,
  conversationEventPageSchema,
} from "@sentry/junior/api/schema";

import { DashboardApiError, fetchDashboardJson, patch } from "../http";
import {
  buildConversationTranscript,
  conversationHistoryBridgeCursor,
  conversationHistoryChanged,
  conversationHistoryVersion,
  loadCompleteConversationTranscript,
  nextConversationHistoryCursor,
  type ConversationHistoryPage,
} from "./transcript";

/** Return the stable cache key for one conversation detail resource. */
export function conversationDetailQueryKey(conversationId: string | undefined) {
  return ["conversation", conversationId, "detail"] as const;
}

/** Define the bounded, polling conversation-detail resource. */
export function conversationDetailQueryOptions(
  conversationId: string | undefined,
) {
  return queryOptions({
    enabled: Boolean(conversationId),
    queryKey: conversationDetailQueryKey(conversationId),
    queryFn: ({ signal }) => readConversationData(conversationId!, signal),
    refetchInterval: (query) =>
      query.state.data?.status === "active" ? 2_000 : false,
    retry: false,
  });
}

/** Archive or restore one conversation with an immediate reversible cache update. */
export function useArchiveConversation(
  conversationId: string,
  options?: { onSuccess?(archived: boolean): void },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { archived: boolean; lastSeenAt: string }) =>
      patch(
        archiveConversationResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/archive`,
        args,
      ),
    onMutate: async (args) => {
      const conversationQueries = { queryKey: ["dashboard", "conversations"] };
      const detailQueryKey = conversationDetailQueryKey(conversationId);
      await Promise.all([
        queryClient.cancelQueries(conversationQueries),
        queryClient.cancelQueries({ queryKey: detailQueryKey }),
      ]);
      const previousFeeds =
        queryClient.getQueriesData<ConversationFeed>(conversationQueries);
      const previousDetail =
        queryClient.getQueryData<ConversationDetailReport>(detailQueryKey);
      const archivedAt = args.archived ? new Date().toISOString() : undefined;

      queryClient.setQueriesData<ConversationFeed>(
        conversationQueries,
        (feed) =>
          feed
            ? {
                ...feed,
                conversations: feed.conversations.map((conversation) =>
                  conversation.conversationId === conversationId
                    ? { ...conversation, archivedAt }
                    : conversation,
                ),
              }
            : feed,
      );
      queryClient.setQueryData<ConversationDetailReport>(
        detailQueryKey,
        (detail) => (detail ? { ...detail, archivedAt } : detail),
      );
      return { detailQueryKey, previousDetail, previousFeeds };
    },
    onError: (_error, _args, context) => {
      context?.previousFeeds.forEach(([queryKey, feed]) => {
        queryClient.setQueryData(queryKey, feed);
      });
      if (context) {
        queryClient.setQueryData(
          context.detailQueryKey,
          context.previousDetail,
        );
      }
    },
    onSuccess: (_result, args) => options?.onSuccess?.(args.archived),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["dashboard", "conversations"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["dashboard", "locations"],
        }),
        queryClient.invalidateQueries({ queryKey: ["dashboard", "people"] }),
        queryClient.invalidateQueries({
          exact: true,
          queryKey: conversationDetailQueryKey(conversationId),
        }),
      ]);
    },
  });
}

/** Fetch a bounded conversation snapshot and older pages on demand. */
export function useConversationData(conversationId: string | undefined) {
  const queryClient = useQueryClient();
  const detail = useQuery(conversationDetailQueryOptions(conversationId));
  const historyStatus = detail.data?.eventHistory.status;
  const historyQueryKey = useMemo(
    () => ["conversation", conversationId, "history", historyStatus] as const,
    [conversationId, historyStatus],
  );
  const history = useInfiniteQuery({
    enabled: false,
    queryKey: historyQueryKey,
    queryFn: async ({
      pageParam,
      signal,
    }): Promise<ConversationHistoryPage> => ({
      ...(await readConversationEvents(conversationId!, pageParam, signal)),
      requestedBefore: pageParam,
    }),
    initialPageParam: detail.data?.previousCursor ?? "",
    getNextPageParam: (_page, pages) =>
      nextConversationHistoryCursor(detail.data?.previousCursor, pages),
    retry: false,
  });

  const historyPages = history.data?.pages;
  const data = useMemo(
    () =>
      detail.data
        ? buildConversationTranscript(detail.data, historyPages ?? [])
        : undefined,
    [detail.data, historyPages],
  );
  const invalidHistoryCursor = isInvalidCursorError(history.error);
  const shouldRefreshDetail = Boolean(
    detail.data &&
    (conversationHistoryChanged(detail.data, historyPages ?? []) ||
      invalidHistoryCursor),
  );
  const historyError = invalidHistoryCursor ? null : history.error;
  const historyNeedsReconciliation = Boolean(
    detail.data?.previousCursor &&
    history.data &&
    conversationHistoryBridgeCursor(
      detail.data.previousCursor,
      history.data.pages,
    ) &&
    !shouldRefreshDetail &&
    !history.error &&
    !history.isFetchingNextPage,
  );
  const isLoadingPreviousPage =
    history.isFetchingNextPage || historyNeedsReconciliation;

  useEffect(() => {
    if (shouldRefreshDetail) void detail.refetch();
  }, [detail.refetch, shouldRefreshDetail]);

  useEffect(() => {
    if (invalidHistoryCursor) {
      void queryClient.resetQueries({
        exact: true,
        queryKey: historyQueryKey,
      });
    }
  }, [historyQueryKey, invalidHistoryCursor, queryClient]);

  useEffect(() => {
    if (historyNeedsReconciliation) void history.fetchNextPage();
  }, [history.fetchNextPage, historyNeedsReconciliation]);

  return {
    ...detail,
    data,
    historyError,
    historyVersion: conversationHistoryVersion(historyPages ?? []),
    hasPreviousPage: history.data
      ? history.hasNextPage
      : Boolean(detail.data?.previousCursor),
    isLoadingPreviousPage,
    loadCompleteTranscript: () => {
      if (!conversationId || !detail.data) {
        throw new Error("Cannot load a conversation without an id");
      }
      return loadCompleteConversationTranscript({
        detail: detail.data,
        historyPages: history.data?.pages ?? [],
        readPage: (before) => readConversationEvents(conversationId, before),
      });
    },
    loadPreviousPage: () => {
      const hasPreviousPage = history.data
        ? history.hasNextPage
        : Boolean(detail.data?.previousCursor);
      if (conversationId && hasPreviousPage && !history.isFetchingNextPage) {
        void history.fetchNextPage();
      }
    },
  };
}

/** Read one bounded conversation-detail resource. */
export function readConversationData(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationDetailReport> {
  return fetchDashboardJson(
    conversationDetailReportSchema,
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    signal,
  );
}

/** Read one bounded page of events before the supplied history cursor. */
export function readConversationEvents(
  conversationId: string,
  before: string,
  signal?: AbortSignal,
): Promise<ConversationEventPage> {
  const query = new URLSearchParams({ before });
  return fetchDashboardJson(
    conversationEventPageSchema,
    `/api/conversations/${encodeURIComponent(conversationId)}/events?${query}`,
    signal,
  ).then((page) => {
    if (page.previousCursor === before) {
      throw new Error("Conversation history cursor did not advance");
    }
    return page;
  });
}

function isInvalidCursorError(error: Error | null): boolean {
  return error instanceof DashboardApiError && error.status === 400;
}
