import { useEffect, useMemo } from "react";
import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ConversationDetailReport,
  ConversationEventPage,
  ConversationFeed,
  ConversationPendingMessagesReport,
  ConversationSummaryReport,
} from "@sentry/junior/api/schema";
import {
  acceptedConversationMessageSchema,
  archiveConversationResponseSchema,
  cancelConversationPendingMessagesResponseSchema,
  conversationDetailReportSchema,
  conversationEventPageSchema,
  conversationPendingMessagesReportSchema,
} from "@sentry/junior/api/schema";

import {
  DashboardApiError,
  del,
  fetchDashboardJson,
  patch,
  post,
} from "../http";
import {
  conversationOutboxMessageForSubmit,
  conversationOutboxQueryKey,
  failConversationOutboxMessage,
  mergeConversationMailboxMessages,
  removeConversationOutboxMessage,
  upsertConversationOutboxMessage,
  type ConversationOutboxMessage,
} from "./conversationOutbox";
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

function archivedConversationQueryKey(conversationId: string) {
  return ["dashboard", "archived-conversation", conversationId] as const;
}

/** Read active/archived status from a dashboard conversations query key. */
function conversationFeedStatus(
  queryKey: readonly unknown[],
): "active" | "archived" | undefined {
  const status = queryKey[queryKey.length - 1];
  return status === "active" || status === "archived" ? status : undefined;
}

type ArchivedConversationSnapshot = {
  conversation: ConversationSummaryReport;
  feedQueryHashes: string[];
};

const archiveConversationMutationKey = [
  "dashboard",
  "archive-conversation",
] as const;

type ArchiveConversationVariables = {
  archived: boolean;
  lastSeenAt: string;
};

type ArchiveConversationMutationContext = {
  archivedQueryKey: ReturnType<typeof archivedConversationQueryKey>;
  archivedSnapshot?: ArchivedConversationSnapshot;
  detailQueryKey: ReturnType<typeof conversationDetailQueryKey>;
  previousArchivedSnapshot?: ArchivedConversationSnapshot;
  previousDetail?: ConversationDetailReport;
  previousFeeds: Array<[readonly unknown[], ConversationFeed | undefined]>;
};

export type PendingArchiveConversationUpdate = {
  archived: boolean;
  conversation?: ConversationSummaryReport;
  conversationId: string;
};

/** Read pending archive state so refetches cannot visually replace optimistic UI. */
export function usePendingArchiveConversationUpdates() {
  return useMutationState({
    filters: {
      mutationKey: archiveConversationMutationKey,
      status: "pending",
    },
    select: (mutation) => {
      const variables = mutation.state
        .variables as ArchiveConversationVariables;
      const context = mutation.state.context as
        | ArchiveConversationMutationContext
        | undefined;
      const conversationId = mutation.options.mutationKey?.[2];
      return {
        archived: variables.archived,
        conversation: context?.archivedSnapshot?.conversation,
        conversationId:
          typeof conversationId === "string" ? conversationId : "",
      } satisfies PendingArchiveConversationUpdate;
    },
  });
}

/** Return the stable cache key for one conversation mailbox snapshot. */
export function conversationPendingMessagesQueryKey(
  conversationId: string | undefined,
) {
  return ["conversation", conversationId, "pending-messages"] as const;
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

/** Define the bounded mailbox snapshot polled while work may still be queued. */
export function conversationPendingMessagesQueryOptions(
  conversationId: string | undefined,
  options?: { activeConversation?: boolean },
) {
  return queryOptions({
    enabled: Boolean(conversationId),
    queryKey: conversationPendingMessagesQueryKey(conversationId),
    queryFn: ({ signal }) =>
      readConversationPendingMessages(conversationId!, signal),
    refetchInterval: (query) =>
      options?.activeConversation ||
      Boolean(query.state.data?.messages.length) ||
      Boolean(query.state.data?.authorization)
        ? 2_000
        : false,
    retry: false,
  });
}

/** Create one dashboard conversation and refresh the personal feed. */
export function useCreateConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      idempotencyKey: string;
      message: string;
      visibility?: "private" | "public";
    }) => post(acceptedConversationMessageSchema, "/api/conversations", args),
    onSuccess: (accepted) => {
      void queryClient.invalidateQueries({
        queryKey: ["dashboard", "conversations"],
      });
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: conversationPendingMessagesQueryKey(accepted.conversationId),
      });
    },
  });
}

/** Add one dashboard message and refresh the shared transcript. */
export function useAppendConversationMessage(conversationId: string) {
  const queryClient = useQueryClient();
  const outboxQueryKey = conversationOutboxQueryKey(conversationId);
  return useMutation({
    mutationFn: (args: { idempotencyKey: string; message: string }) =>
      post(
        acceptedConversationMessageSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        args,
      ),
    onMutate: async (args) => {
      const optimistic = conversationOutboxMessageForSubmit(args);
      queryClient.setQueryData<ConversationOutboxMessage[]>(
        outboxQueryKey,
        (current) => upsertConversationOutboxMessage(current, optimistic),
      );
    },
    onError: (_error, args) => {
      queryClient.setQueryData<ConversationOutboxMessage[]>(
        outboxQueryKey,
        (current) =>
          failConversationOutboxMessage(current, args.idempotencyKey),
      );
    },
    onSuccess: (_accepted, args) => {
      queryClient.setQueryData<ConversationOutboxMessage[]>(
        outboxQueryKey,
        (current) =>
          removeConversationOutboxMessage(current, args.idempotencyKey),
      );
      void queryClient.invalidateQueries({
        queryKey: ["dashboard", "conversations"],
      });
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: conversationDetailQueryKey(conversationId),
      });
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: conversationPendingMessagesQueryKey(conversationId),
      });
    },
  });
}

/** Cancel accepted human-facing mailbox rows for the open conversation. */
export function useCancelConversationPendingMessages(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      inboundMessageIds: string[];
      receivedBefore: string;
    }) =>
      del(
        cancelConversationPendingMessagesResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/pending-messages`,
        args,
      ),
    onMutate: async (args) => {
      await queryClient.cancelQueries({
        exact: true,
        queryKey: conversationPendingMessagesQueryKey(conversationId),
      });
      const previousPending =
        queryClient.getQueryData<ConversationPendingMessagesReport>(
          conversationPendingMessagesQueryKey(conversationId),
        );
      if (previousPending) {
        queryClient.setQueryData<ConversationPendingMessagesReport>(
          conversationPendingMessagesQueryKey(conversationId),
          {
            ...previousPending,
            messages: previousPending.messages.filter(
              (message) =>
                !args.inboundMessageIds.includes(message.inboundMessageId),
            ),
          },
        );
      }
      return { previousPending };
    },
    onError: (_error, _args, context) => {
      if (context?.previousPending) {
        queryClient.setQueryData(
          conversationPendingMessagesQueryKey(conversationId),
          context.previousPending,
        );
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["dashboard", "conversations"],
        }),
        queryClient.invalidateQueries({
          exact: true,
          queryKey: conversationDetailQueryKey(conversationId),
        }),
        queryClient.invalidateQueries({
          exact: true,
          queryKey: conversationPendingMessagesQueryKey(conversationId),
        }),
      ]);
    },
  });
}

/** Archive or restore one conversation with an immediate reversible cache update. */
export function useArchiveConversation(
  conversationId: string,
  options?: {
    onError?(): void;
    onSuccess?(archived: boolean): void;
  },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...archiveConversationMutationKey, conversationId],
    mutationFn: (args: ArchiveConversationVariables) =>
      patch(
        archiveConversationResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/archive`,
        args,
      ),
    onMutate: async (args) => {
      const conversationQueries = { queryKey: ["dashboard", "conversations"] };
      const detailQueryKey = conversationDetailQueryKey(conversationId);
      const archivedQueryKey = archivedConversationQueryKey(conversationId);
      await Promise.all([
        queryClient.cancelQueries(conversationQueries),
        queryClient.cancelQueries({ queryKey: detailQueryKey }),
      ]);
      const previousFeeds =
        queryClient.getQueriesData<ConversationFeed>(conversationQueries);
      const previousDetail =
        queryClient.getQueryData<ConversationDetailReport>(detailQueryKey);
      const previousArchivedSnapshot =
        queryClient.getQueryData<ArchivedConversationSnapshot>(
          archivedQueryKey,
        );
      const archivedAt = args.archived ? new Date().toISOString() : undefined;
      // Snapshot from any loaded feed, including archived-only fixtures that
      // were never archived through this client session.
      const archivedSnapshot =
        buildArchivedConversationSnapshot(previousFeeds, conversationId) ??
        previousArchivedSnapshot;

      previousFeeds.forEach(([queryKey, feed]) => {
        if (!feed) return;
        const conversationExists = feed.conversations.some(
          (conversation) => conversation.conversationId === conversationId,
        );
        const feedStatus = conversationFeedStatus(queryKey);
        const shouldRestore =
          !args.archived &&
          !conversationExists &&
          Boolean(archivedSnapshot) &&
          feedStatus !== "archived";
        const conversations = shouldRestore
          ? [
              ...feed.conversations,
              { ...archivedSnapshot!.conversation, archivedAt: undefined },
            ].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
          : feed.conversations.map((conversation) =>
              conversation.conversationId === conversationId
                ? { ...conversation, archivedAt }
                : conversation,
            );
        queryClient.setQueryData<ConversationFeed>(queryKey, {
          ...feed,
          conversations,
        });
      });
      queryClient.setQueryData<ConversationDetailReport>(
        detailQueryKey,
        (detail) => (detail ? { ...detail, archivedAt } : detail),
      );
      if (archivedSnapshot) {
        queryClient.setQueryData(archivedQueryKey, archivedSnapshot);
      }
      return {
        archivedQueryKey,
        archivedSnapshot,
        detailQueryKey,
        previousArchivedSnapshot,
        previousDetail,
        previousFeeds,
      } satisfies ArchiveConversationMutationContext;
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
        if (context.previousArchivedSnapshot) {
          queryClient.setQueryData(
            context.archivedQueryKey,
            context.previousArchivedSnapshot,
          );
        } else {
          queryClient.removeQueries({
            exact: true,
            queryKey: context.archivedQueryKey,
          });
        }
      }
      options?.onError?.();
    },
    onSuccess: (_result, args) => {
      if (!args.archived) {
        queryClient.removeQueries({
          exact: true,
          queryKey: archivedConversationQueryKey(conversationId),
        });
      }
      options?.onSuccess?.(args.archived);
    },
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

function buildArchivedConversationSnapshot(
  feeds: Array<[readonly unknown[], ConversationFeed | undefined]>,
  conversationId: string,
): ArchivedConversationSnapshot | undefined {
  let conversation: ConversationSummaryReport | undefined;
  const feedQueryHashes: string[] = [];
  for (const [queryKey, feed] of feeds) {
    const feedConversation = feed?.conversations.find(
      (item) => item.conversationId === conversationId,
    );
    if (!feedConversation) continue;
    conversation ??= feedConversation;
    feedQueryHashes.push(JSON.stringify(queryKey));
  }
  return conversation ? { conversation, feedQueryHashes } : undefined;
}

/** Fetch a bounded conversation snapshot and older pages on demand. */
export function useConversationData(conversationId: string | undefined) {
  const queryClient = useQueryClient();
  const detail = useQuery(conversationDetailQueryOptions(conversationId));
  const pending = useQuery(
    conversationPendingMessagesQueryOptions(conversationId, {
      activeConversation: detail.data?.status === "active",
    }),
  );
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
  const outbox = useQuery({
    enabled: Boolean(conversationId),
    // Local-only cache. Never replace optimistic rows with an empty fetch result.
    queryFn: async (): Promise<ConversationOutboxMessage[]> =>
      queryClient.getQueryData<ConversationOutboxMessage[]>(
        conversationOutboxQueryKey(conversationId),
      ) ?? [],
    queryKey: conversationOutboxQueryKey(conversationId),
    initialData: [],
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const pendingMessages = useMemo(
    () => mergeConversationMailboxMessages(pending.data?.messages, outbox.data),
    [outbox.data, pending.data?.messages],
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

  const refetchDetail = detail.refetch;
  useEffect(() => {
    if (shouldRefreshDetail) void refetchDetail();
  }, [refetchDetail, shouldRefreshDetail]);

  useEffect(() => {
    if (invalidHistoryCursor) {
      void queryClient.resetQueries({
        exact: true,
        queryKey: historyQueryKey,
      });
    }
  }, [historyQueryKey, invalidHistoryCursor, queryClient]);

  const fetchNextHistoryPage = history.fetchNextPage;
  useEffect(() => {
    if (historyNeedsReconciliation) void fetchNextHistoryPage();
  }, [fetchNextHistoryPage, historyNeedsReconciliation]);

  return {
    data,
    error: detail.error,
    historyError,
    historyVersion: conversationHistoryVersion(historyPages ?? []),
    hasPreviousPage: history.data
      ? history.hasNextPage
      : Boolean(detail.data?.previousCursor),
    isPending: detail.isPending,
    isLoadingPreviousPage,
    pendingAuthorization: pending.data?.authorization,
    pendingGeneratedAt: pending.data?.generatedAt,
    pendingMessages,
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

/** Read accepted mailbox messages that have not reached durable history yet. */
export function readConversationPendingMessages(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationPendingMessagesReport> {
  return fetchDashboardJson(
    conversationPendingMessagesReportSchema,
    `/api/conversations/${encodeURIComponent(conversationId)}/pending-messages`,
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
