import { useDeferredValue, useEffect, useMemo, useRef } from "react";
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
  InputImage,
} from "@sentry/junior/api/schema";
import {
  acceptedConversationMessageSchema,
  webMessageId,
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
  readDashboardResponse,
} from "../http";
import {
  conversationOutboxMessageForSubmit,
  conversationOutboxQueryKey,
  failConversationOutboxMessage,
  mergeConversationMailboxMessages,
  acceptConversationOutboxMessage,
  upsertConversationOutboxMessage,
  type ConversationMailboxMessage,
  type ConversationOutboxMessage,
} from "./conversationOutbox";
import {
  buildConversationTranscript,
  conversationHistoryBridgeCursor,
  conversationHistoryChanged,
  conversationHistoryVersion,
  loadCompleteConversationTranscript,
  nextConversationHistoryCursor,
  reuseConversationEventReferences,
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

type ConversationSnapshot = ConversationDetailReport & {
  mailbox?: ConversationPendingMessagesReport;
  detailEtag?: string;
};

/** Read the mailbox before history so acknowledged input is already committed. */
async function readConversationSnapshot(
  conversationId: string,
  signal?: AbortSignal,
  previous?: ConversationSnapshot,
): Promise<ConversationSnapshot> {
  const mailbox = await readConversationPendingMessages(conversationId, signal);
  const detail = await readConversationData(conversationId, signal, previous);
  return { ...detail, mailbox };
}

/** Refresh history and mailbox as one visible snapshot, including idle input. */
export function conversationDetailQueryOptions(
  conversationId: string | undefined,
  options?: { awaitingMessage?: boolean },
) {
  return queryOptions({
    enabled: Boolean(conversationId),
    queryKey: conversationDetailQueryKey(conversationId),
    queryFn: ({ signal, client }) =>
      readConversationSnapshot(
        conversationId!,
        signal,
        client.getQueryData<ConversationSnapshot>(
          conversationDetailQueryKey(conversationId),
        ),
      ),
    structuralSharing: (previous, next) => {
      if (!next || typeof next !== "object") return next;
      if (!previous || typeof previous !== "object") return next;
      return reuseConversationEventReferences(
        previous as ConversationSnapshot,
        next as ConversationSnapshot,
      );
    },
    refetchInterval: (query) =>
      options?.awaitingMessage ||
      query.state.data?.status === "active" ||
      Boolean(query.state.data?.mailbox?.messages.length) ||
      Boolean(query.state.data?.mailbox?.authorization)
        ? 2_000
        : 10_000,
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
      images?: InputImage[];
      visibility?: "private" | "public";
    }) => post(acceptedConversationMessageSchema, "/api/conversations", args),
    onSuccess: (accepted, args) => {
      queryClient.setQueryData<ConversationOutboxMessage[]>(
        conversationOutboxQueryKey(accepted.conversationId),
        (current) =>
          upsertConversationOutboxMessage(current, {
            ...conversationOutboxMessageForSubmit({
              ...args,
              messageId: accepted.messageId,
            }),
            status: "accepted",
          }),
      );
      void queryClient.invalidateQueries({
        queryKey: ["dashboard", "conversations"],
      });
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: conversationDetailQueryKey(accepted.conversationId),
      });
    },
  });
}

/** Add one dashboard message and refresh the shared transcript. */
export function useAppendConversationMessage(conversationId: string) {
  const queryClient = useQueryClient();
  const outboxQueryKey = conversationOutboxQueryKey(conversationId);
  return useMutation({
    mutationFn: (args: {
      idempotencyKey: string;
      message: string;
      images?: InputImage[];
    }) =>
      post(
        acceptedConversationMessageSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        args,
      ),
    onMutate: async (args) => {
      // Use the durable id from the first render. No server read is needed,
      // and a poll that beats POST cannot create a second copy.
      const messageId = await webMessageId({
        conversationId,
        idempotencyKey: args.idempotencyKey,
      });
      const optimistic = conversationOutboxMessageForSubmit({
        ...args,
        messageId,
      });
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
    onSuccess: (accepted, args) => {
      queryClient.setQueryData<ConversationOutboxMessage[]>(
        outboxQueryKey,
        (current) =>
          acceptConversationOutboxMessage(
            current,
            args.idempotencyKey,
            accepted.messageId,
          ),
      );
      void queryClient.invalidateQueries({
        queryKey: ["dashboard", "conversations"],
      });
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: conversationDetailQueryKey(conversationId),
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
        queryKey: conversationDetailQueryKey(conversationId),
      });
      const previousPending = queryClient.getQueryData<ConversationSnapshot>(
        conversationDetailQueryKey(conversationId),
      );
      if (previousPending?.mailbox) {
        queryClient.setQueryData<ConversationSnapshot>(
          conversationDetailQueryKey(conversationId),
          {
            ...previousPending,
            mailbox: {
              ...previousPending.mailbox,
              messages: previousPending.mailbox.messages.filter(
                (message) =>
                  !args.inboundMessageIds.includes(message.inboundMessageId),
              ),
            },
          },
        );
      }
      return { previousPending };
    },
    onError: (_error, _args, context) => {
      if (context?.previousPending) {
        queryClient.setQueryData<ConversationSnapshot>(
          conversationDetailQueryKey(conversationId),
          (current) =>
            current
              ? { ...current, mailbox: context.previousPending?.mailbox }
              : current,
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
      ]);
    },
  });
}

/** Archive or restore one conversation with an immediate reversible cache update. */
export function useArchiveConversation(
  conversationId: string,
  options?: {
    onError?(): void;
    onSuccess?(archivedAt: string | null): void;
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
      const archivedAt = args.archived ? new Date().toISOString() : null;
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
              { ...archivedSnapshot!.conversation, archivedAt: null },
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
      queryClient.setQueryData<ConversationSnapshot>(
        detailQueryKey,
        (detail) =>
          detail ? { ...detail, archivedAt, detailEtag: undefined } : detail,
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
    onSuccess: (result, args) => {
      queryClient.setQueryData<ConversationSnapshot>(
        conversationDetailQueryKey(conversationId),
        (detail) =>
          detail
            ? {
                ...detail,
                archivedAt: result.archivedAt,
                detailEtag: undefined,
              }
            : detail,
      );
      if (!args.archived) {
        queryClient.removeQueries({
          exact: true,
          queryKey: archivedConversationQueryKey(conversationId),
        });
      }
      options?.onSuccess?.(result.archivedAt);
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
  const awaitingMessage = outbox.data.some(
    (message) => message.status !== "failed",
  );
  const detail = useQuery(
    conversationDetailQueryOptions(conversationId, { awaitingMessage }),
  );
  // Defer the whole server snapshot, not history alone. Queue removal and the
  // matching transcript must paint together while composer input stays urgent.
  const deferredDetail = useDeferredValue(detail.data);
  // Defer refreshes only within this Conversation. First load and navigation
  // must use the current query, never an empty or different Conversation snapshot.
  const detailData =
    deferredDetail && deferredDetail.conversationId === conversationId
      ? deferredDetail
      : detail.data;
  const mailbox = detailData?.mailbox;
  // Accept is not visibility. Keep a local row until either server resource
  // contains its real Message id. History and mailbox arrive in one render.
  useEffect(() => {
    if (!mailbox || !detailData) return;
    const observedIds = new Set(
      mailbox.messages.map((message) => message.messageId),
    );
    for (const event of detailData.events) {
      if (event.data.type === "message") observedIds.add(event.data.messageId);
    }
    queryClient.setQueryData<ConversationOutboxMessage[]>(
      conversationOutboxQueryKey(conversationId),
      (current) => {
        const next = current?.filter(
          (message) => !observedIds.has(message.messageId),
        );
        return next?.length === current?.length ? current : next;
      },
    );
  }, [conversationId, detailData, mailbox, outbox.data, queryClient]);
  const historyStatus = detailData?.eventHistory.status;
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
    initialPageParam: detailData?.previousCursor ?? "",
    getNextPageParam: (_page, pages) =>
      nextConversationHistoryCursor(detailData?.previousCursor, pages),
    retry: false,
  });

  const historyPages = history.data?.pages;
  const data = useMemo(
    () =>
      detailData
        ? buildConversationTranscript(detailData, historyPages ?? [])
        : undefined,
    [detailData, historyPages],
  );
  // Live polls mint fresh server arrays every 2s. Reuse the previous list when
  // visible mailbox rows are unchanged so the reply footer can skip work while
  // the reader types.
  const pendingMessagesRef = useRef<ConversationMailboxMessage[] | undefined>(
    undefined,
  );
  const pendingMessages = useMemo(() => {
    const next = mergeConversationMailboxMessages(
      mailbox?.messages,
      outbox.data,
      pendingMessagesRef.current,
    );
    pendingMessagesRef.current = next;
    return next;
  }, [outbox.data, mailbox?.messages]);
  const invalidHistoryCursor = isInvalidCursorError(history.error);
  const shouldRefreshDetail = Boolean(
    detailData &&
    (conversationHistoryChanged(detailData, historyPages ?? []) ||
      invalidHistoryCursor),
  );
  const historyError = invalidHistoryCursor ? null : history.error;
  const historyNeedsReconciliation = Boolean(
    detailData?.previousCursor &&
    history.data &&
    conversationHistoryBridgeCursor(
      detailData.previousCursor,
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
      : Boolean(detailData?.previousCursor),
    isPending: detail.isPending,
    isLoadingPreviousPage,
    pendingAuthorization: mailbox?.authorization,
    pendingGeneratedAt: mailbox?.generatedAt,
    pendingMessages,
    loadCompleteTranscript: () => {
      if (!conversationId || !detailData) {
        throw new Error("Cannot load a conversation without an id");
      }
      return loadCompleteConversationTranscript({
        detail: detailData,
        historyPages: history.data?.pages ?? [],
        readPage: (before) => readConversationEvents(conversationId, before),
      });
    },
    loadPreviousPage: () => {
      const hasPreviousPage = history.data
        ? history.hasNextPage
        : Boolean(detailData?.previousCursor);
      if (conversationId && hasPreviousPage && !history.isFetchingNextPage) {
        void history.fetchNextPage();
      }
    },
  };
}

/** Revalidate one bounded detail resource against its query-owned snapshot. */
export async function readConversationData(
  conversationId: string,
  signal?: AbortSignal,
  previous?: ConversationSnapshot,
): Promise<ConversationSnapshot> {
  const response = await readDashboardResponse(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    signal,
    previous?.detailEtag,
  );
  if (response.status === 304 && previous) return previous;
  const report = conversationDetailReportSchema.parse(await response.json());
  return { ...report, detailEtag: response.headers.get("etag") ?? undefined };
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
