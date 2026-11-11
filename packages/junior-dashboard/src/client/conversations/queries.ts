import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import * as z from "zod";
import {
  type QueryClient,
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
  ConversationPendingMessagesReport,
} from "@sentry/junior/api/schema";
import {
  acceptedConversationMessageSchema,
  CONVERSATION_DETAIL_VERSION_HEADER,
  CONVERSATION_VERSION_HEADER,
  webMessageId,
  cancelConversationPendingMessagesResponseSchema,
  conversationDetailReportSchema,
  conversationDetailWithMailboxReportSchema,
  conversationEventPageSchema,
  conversationUnchangedDetailWithMailboxSchema,
  forkConversationResponseSchema,
  steerConversationPendingMessagesResponseSchema,
  stopConversationTurnResponseSchema,
} from "@sentry/junior/api/schema";

import { postWebMessage } from "./attachmentUploads";
import { readResponseJson } from "../sentry";
import {
  DashboardApiError,
  del,
  fetchDashboardJson,
  post,
  readDashboardResponse,
} from "../http";
import {
  conversationOutboxMessageForSubmit,
  conversationOutboxQueryKey,
  failConversationOutboxMessage,
  mergeConversationMailboxMessages,
  outboxActorIdentity,
  acceptConversationOutboxMessage,
  reuseConversationMailboxMessages,
  settleConversationOutboxMessages,
  splitInlineMailboxMessages,
  upsertConversationOutboxMessage,
  type ConversationMailboxMessage,
  type ConversationOutboxMessage,
} from "./conversationOutbox";
import { refreshSideReadsOnChange } from "./conversationSideReads";
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

/**
 * Read reports and Mark as unread for one conversation share this scope, so
 * they reach the server one at a time, in order. A forward-only read report
 * that is in flight can then not undo a later Mark as unread.
 */
export function conversationReadScope(conversationId: string) {
  return { id: `conversation:${conversationId}:read` };
}

/** Return the mutation key for Mark as read or unread on one conversation. */
export function conversationUnreadMutationKey(conversationId: string) {
  return ["conversation", conversationId, "unread"] as const;
}

// Right after a send, Junior usually reads the message within a few seconds.
// Poll fast for that window only, then fall back to the normal live interval.
const FAST_POLL_INTERVAL_MS = 500;
const FAST_POLL_WINDOW_MS = 6_000;

/** The cached detail report with its mailbox and revalidation ETag. */
export type ConversationSnapshot = ConversationDetailReport & {
  mailbox?: ConversationPendingMessagesReport;
  /** Client time when this snapshot started its mailbox read. */
  mailboxReadAtMs?: number;
  detailEtag?: string;
  /** Tree token that the report was built from, for the versions poll. */
  conversationVersion?: string;
  /** Set by a list hover prefetch, so the next visit can use it as its open fetch. */
  prefetchedAtMs?: number;
};

// A hover prefetch this recent is the open fetch of the next visit. The
// reader has not opened the Conversation since, so its read position and
// unread page are still the ones that the open would get.
const PREFETCH_OPEN_WINDOW_MS = 30_000;

function dropPrefetchMark(client: QueryClient, conversationId: string) {
  const key = conversationDetailQueryKey(conversationId);
  const state = client.getQueryState<ConversationSnapshot>(key);
  if (!state?.data?.prefetchedAtMs) return;
  const { prefetchedAtMs: _prefetchedAtMs, ...rest } = state.data;
  // Keep the fetch time, so the copy goes stale as it would have.
  client.setQueryData<ConversationSnapshot>(key, rest, {
    updatedAt: state.dataUpdatedAt,
  });
}

function isOpenPrefetch(snapshot: ConversationSnapshot | undefined) {
  return Boolean(
    snapshot?.prefetchedAtMs &&
    Date.now() - snapshot.prefetchedAtMs < PREFETCH_OPEN_WINDOW_MS,
  );
}

/**
 * Whether the detail polls by itself: a Turn runs, input waits in the
 * mailbox, or the viewer must authorize a connection.
 */
export function conversationDetailIsLive(
  snapshot: ConversationSnapshot | undefined,
): boolean {
  return (
    snapshot?.status === "active" ||
    Boolean(snapshot?.mailbox?.messages.length) ||
    Boolean(snapshot?.mailbox?.authorization)
  );
}

/** Refresh history and mailbox as one visible snapshot, including idle input. */
export function conversationDetailQueryOptions(
  conversationId: string | undefined,
  options?: {
    awaitingMessage?: boolean;
    /** Poll fast until this time so a new send reaches history quickly. */
    fastPollUntilMs?: number;
    /** Also read the page around the read position. */
    unreadPage?: boolean;
    /**
     * The versions poll refreshes this Conversation while it is idle, so
     * the detail does not poll then.
     */
    versionsPoll?: boolean;
  },
) {
  // `unreadPage` adds a page to one fetch. The detail in the cache is the
  // same, so it stays out of the key.
  // oxlint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    enabled: Boolean(conversationId),
    queryKey: conversationDetailQueryKey(conversationId),
    queryFn: async ({ signal, client }) => {
      const previous = client.getQueryData<ConversationSnapshot>(
        conversationDetailQueryKey(conversationId),
      );
      // The server reads the mailbox before history, so acknowledged input
      // is in at least one of them.
      const next = await readConversationData(
        conversationId!,
        signal,
        previous,
        { mailbox: true, unreadPage: options?.unreadPage },
      );
      refreshSideReadsOnChange(client, conversationId!, previous, next);
      return next;
    },
    structuralSharing: (previous, next) => {
      if (!next || typeof next !== "object") return next;
      if (!previous || typeof previous !== "object") return next;
      return keepLatestReadPosition(
        previous as ConversationSnapshot,
        reuseConversationEventReferences(
          previous as ConversationSnapshot,
          next as ConversationSnapshot,
        ),
      );
    },
    refetchInterval: (query) =>
      options?.fastPollUntilMs && Date.now() < options.fastPollUntilMs
        ? FAST_POLL_INTERVAL_MS
        : options?.awaitingMessage || conversationDetailIsLive(query.state.data)
          ? 2_000
          : options?.versionsPoll
            ? false
            : 10_000,
    retry: false,
  });
}

/**
 * Read positions only move forward. A poll that started before a read report
 * finished must not put an older position back in the cache, nor the unread
 * cursor of that older position. The cache already holds the cursor for the
 * newer position: a read does not change the detail version, so no later poll
 * would bring it back. Mark as unread is the one backward move, on this or
 * another device. The server then reports the Conversation unread, so take
 * its position.
 */
function keepLatestReadPosition(
  previous: ConversationSnapshot,
  next: ConversationSnapshot,
): ConversationSnapshot {
  const kept = previous.readPosition;
  if (!kept || next.unread) return next;
  if ((next.readPosition?.lastReadSeq ?? -1) >= kept.lastReadSeq) return next;
  const { unreadCursor: _olderCursor, unreadPage: _olderPage, ...rest } = next;
  return {
    ...rest,
    readPosition: kept,
    ...(previous.unreadCursor
      ? { unreadCursor: previous.unreadCursor, unreadPage: previous.unreadPage }
      : undefined),
  };
}

/** Create one dashboard conversation and refresh the personal feed. */
export function useCreateConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      idempotencyKey: string;
      message: string;
      files?: File[];
      visibility?: "private" | "public";
    }) => postWebMessage("/api/conversations", args),
    onSuccess: (accepted, args) => {
      queryClient.setQueryData<ConversationOutboxMessage[]>(
        conversationOutboxQueryKey(accepted.conversationId),
        (current) =>
          upsertConversationOutboxMessage(current, {
            ...conversationOutboxMessageForSubmit({
              ...args,
              actorIdentity: outboxActorIdentity(queryClient),
              // A new Conversation has no Turn or queue yet.
              inline: true,
              messageId: accepted.messageId,
            }),
            acceptedAtMs: Date.now(),
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

/**
 * Fork a conversation at one assistant reply and send the first message to
 * the fork. A retry with the same key returns the same fork and message.
 */
export function useForkConversation(sourceConversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      idempotencyKey: string;
      message: string;
      messageId: string;
    }) => {
      const fork = await post(
        forkConversationResponseSchema,
        `/api/conversations/${encodeURIComponent(sourceConversationId)}/forks`,
        { messageId: args.messageId, idempotencyKey: args.idempotencyKey },
      );
      return post(
        acceptedConversationMessageSchema,
        `/api/conversations/${encodeURIComponent(fork.conversationId)}/messages`,
        { idempotencyKey: args.idempotencyKey, message: args.message },
      );
    },
    onSuccess: (accepted, args) => {
      queryClient.setQueryData<ConversationOutboxMessage[]>(
        conversationOutboxQueryKey(accepted.conversationId),
        (current) =>
          upsertConversationOutboxMessage(current, {
            ...conversationOutboxMessageForSubmit({
              idempotencyKey: args.idempotencyKey,
              message: args.message,
              actorIdentity: outboxActorIdentity(queryClient),
              // A new fork has no Turn or queue yet.
              inline: true,
              messageId: accepted.messageId,
            }),
            acceptedAtMs: Date.now(),
            status: "accepted",
          }),
      );
      void queryClient.invalidateQueries({
        queryKey: ["dashboard", "conversations"],
      });
    },
  });
}

/** Add one dashboard message and refresh the shared transcript. */
export function useAppendConversationMessage(conversationId: string) {
  const queryClient = useQueryClient();
  const outboxQueryKey = conversationOutboxQueryKey(conversationId);
  return useMutation({
    mutationFn: ({
      inline: _inline,
      ...body
    }: {
      idempotencyKey: string;
      /** Show the send in the transcript instead of the queue. */
      inline?: boolean;
      message: string;
      files?: File[];
    }) =>
      postWebMessage(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        body,
        conversationId,
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
        actorIdentity: outboxActorIdentity(queryClient),
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

/** Ask Junior to read the viewer's own queued web messages now. */
export function useSteerConversationPendingMessages(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { inboundMessageIds: string[] }) =>
      post(
        steerConversationPendingMessagesResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/pending-messages/steer`,
        args,
      ),
    onSuccess: async (result) => {
      const steered = new Set(result.steeredInboundMessageIds);
      if (steered.size === 0) return;
      // A live poll that read the mailbox before the steer would restore
      // `defer`. Cancel it; onSettled refetches after the write.
      await queryClient.cancelQueries({
        exact: true,
        queryKey: conversationDetailQueryKey(conversationId),
      });
      queryClient.setQueryData<ConversationSnapshot>(
        conversationDetailQueryKey(conversationId),
        (current) =>
          current?.mailbox
            ? {
                ...current,
                mailbox: {
                  ...current.mailbox,
                  messages: current.mailbox.messages.map((message) =>
                    steered.has(message.inboundMessageId)
                      ? { ...message, delivery: "interrupt" as const }
                      : message,
                  ),
                },
              }
            : current,
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        exact: true,
        queryKey: conversationDetailQueryKey(conversationId),
      });
    },
  });
}

/**
 * Local cache of queued rows that a stop removed. The worker drops them only
 * when it observes the stop, so the mailbox can still list them for a while.
 * Inbound ids are unique, so the cache never needs to forget one.
 */
function stoppedMessageIdsQueryKey(conversationId: string | undefined) {
  return ["conversation", conversationId, "stopped-messages"] as const;
}

/** Stop the active Turn and hide its removed queued rows until polls agree. */
export function useStopConversationTurn(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      post(
        stopConversationTurnResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/stop`,
        {},
      ),
    onSuccess: (result) => {
      const stopped = result.stoppedInboundMessageIds;
      if (!stopped.length) return;
      queryClient.setQueryData<readonly string[]>(
        stoppedMessageIdsQueryKey(conversationId),
        (current) => [...(current ?? []), ...stopped],
      );
      // A web row keeps its Message id as its inbound id. Drop local sends the
      // stop removed so they do not wait for a mailbox row that never comes.
      queryClient.setQueryData<ConversationOutboxMessage[]>(
        conversationOutboxQueryKey(conversationId),
        (current) =>
          current?.filter((message) => !stopped.includes(message.messageId)),
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        exact: true,
        queryKey: conversationDetailQueryKey(conversationId),
      });
    },
  });
}

/** The open Conversation's data, from `useConversationData`. */
export type ConversationData = ReturnType<typeof useConversationData>;

/** Fetch a bounded conversation snapshot and older pages on demand. */
export function useConversationData(
  conversationId: string | undefined,
  options?: {
    /**
     * Ask the first fetch of this visit for the page around the read
     * position. Polls do not ask, so the server reads that page once.
     */
    unreadPageAtOpen?: boolean;
    /** See `conversationDetailQueryOptions`. */
    versionsPoll?: boolean;
  },
) {
  const queryClient = useQueryClient();
  // The shell keeps one hook across Conversations, so a new Conversation
  // starts a new visit. A recent hover prefetch is the open fetch of the visit.
  const startVisit = () => {
    const prefetched = isOpenPrefetch(
      queryClient.getQueryData<ConversationSnapshot>(
        conversationDetailQueryKey(conversationId),
      ),
    );
    return { conversationId, fetched: prefetched, prefetched };
  };
  const [visit, setVisit] = useState(startVisit);
  if (visit.conversationId !== conversationId) {
    setVisit(startVisit());
  }
  const fetchedAtOpen =
    visit.conversationId === conversationId && visit.fetched;
  const openedFromPrefetch =
    visit.conversationId === conversationId && visit.prefetched;
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
  const stoppedMessageIds = useQuery({
    enabled: Boolean(conversationId),
    // Local-only cache written by useStopConversationTurn.
    queryFn: async (): Promise<readonly string[]> =>
      queryClient.getQueryData<readonly string[]>(
        stoppedMessageIdsQueryKey(conversationId),
      ) ?? [],
    queryKey: stoppedMessageIdsQueryKey(conversationId),
    initialData: [],
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const awaitingRows = outbox.data.filter(
    (message) => message.status !== "failed",
  );
  const latestSendAtMs = Math.max(
    0,
    ...awaitingRows.map((message) => Date.parse(message.createdAt)),
  );
  const detail = useQuery({
    ...conversationDetailQueryOptions(conversationId, {
      awaitingMessage: awaitingRows.length > 0,
      fastPollUntilMs: latestSendAtMs
        ? latestSendAtMs + FAST_POLL_WINDOW_MS
        : undefined,
      unreadPage: Boolean(options?.unreadPageAtOpen) && !fetchedAtOpen,
      versionsPoll: options?.versionsPoll,
    }),
  });
  // A reopened Conversation shows the cached copy at once, but it can miss
  // messages that arrived while the reader was away. Fetch it once at the
  // start of each visit, even when the cached copy is still fresh. A fetch
  // that is already running counts, such as a hover prefetch. After a done
  // prefetch, this fetch only checks for newer events.
  const refetchDetail = detail.refetch;
  useEffect(() => {
    if (!conversationId) return;
    void refetchDetail({ cancelRefetch: false });
    // After a visit, the read position can move past the prefetched one.
    return () => dropPrefetchMark(queryClient, conversationId);
  }, [conversationId, queryClient, refetchDetail]);
  if (!fetchedAtOpen && detail.isFetchedAfterMount && !detail.isFetching) {
    setVisit({ conversationId, fetched: true, prefetched: openedFromPrefetch });
  }
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
  // Accept is not visibility. Keep a local row until the server snapshot
  // shows it. History and mailbox arrive in one render.
  useEffect(() => {
    if (!mailbox || !detailData) return;
    queryClient.setQueryData<ConversationOutboxMessage[]>(
      conversationOutboxQueryKey(conversationId),
      (current) =>
        current &&
        settleConversationOutboxMessages(current, {
          events: detailData.events,
          mailboxReadAtMs: detailData.mailboxReadAtMs,
          queued: mailbox.messages,
        }),
    );
  }, [conversationId, detailData, mailbox, outbox.data, queryClient]);
  // The title is generated after the first message, and only the open
  // Conversation polls. Copy a newer title into loaded feeds, such as the
  // sidebar and the home list, so they do not keep the old one.
  const displayTitle = detail.data?.displayTitle;
  const detailUpdatedAt = detail.dataUpdatedAt;
  useEffect(() => {
    if (!conversationId || !displayTitle) return;
    const feeds = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["dashboard", "conversations"] });
    for (const query of feeds) {
      const feed = query.state.data as ConversationFeed | undefined;
      if (!feed || query.state.dataUpdatedAt > detailUpdatedAt) continue;
      const stale = feed.conversations.some(
        (conversation) =>
          conversation.conversationId === conversationId &&
          conversation.displayTitle !== displayTitle,
      );
      if (!stale) continue;
      queryClient.setQueryData<ConversationFeed>(query.queryKey, {
        ...feed,
        conversations: feed.conversations.map((conversation) =>
          conversation.conversationId === conversationId
            ? { ...conversation, displayTitle }
            : conversation,
        ),
      });
    }
  }, [conversationId, detailUpdatedAt, displayTitle, queryClient]);
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
  const inlineMessagesRef = useRef<ConversationMailboxMessage[] | undefined>(
    undefined,
  );
  const { inlineMessages, pendingMessages } = useMemo(() => {
    // Hide stopped rows from both sources, or the outbox copy of a stopped
    // send would look unseen and come back.
    const stopped = stoppedMessageIds.data;
    const server = stopped.length
      ? mailbox?.messages.filter(
          (message) => !stopped.includes(message.inboundMessageId),
        )
      : mailbox?.messages;
    const local = stopped.length
      ? outbox.data.filter((message) => !stopped.includes(message.messageId))
      : outbox.data;
    const split = splitInlineMailboxMessages(
      mergeConversationMailboxMessages(server, local),
      server,
      local,
    );
    const queued = reuseConversationMailboxMessages(
      pendingMessagesRef.current,
      split.queued,
    );
    const inline = reuseConversationMailboxMessages(
      inlineMessagesRef.current,
      split.inline,
    );
    pendingMessagesRef.current = queued;
    inlineMessagesRef.current = inline;
    return { inlineMessages: inline, pendingMessages: queued };
  }, [outbox.data, mailbox?.messages, stoppedMessageIds.data]);
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
    if (historyNeedsReconciliation) {
      void fetchNextHistoryPage({ cancelRefetch: false });
    }
  }, [fetchNextHistoryPage, historyNeedsReconciliation]);

  return {
    data,
    /**
     * The latest page alone, without earlier pages. It is not deferred, so it
     * matches `fetchedDetail` and the read position that came with it.
     */
    latest: detail.data,
    error: detail.error,
    historyError,
    historyVersion: conversationHistoryVersion(historyPages ?? []),
    hasPreviousPage: history.data
      ? history.hasNextPage
      : Boolean(detailData?.previousCursor),
    isPending: detail.isPending,
    /** The first fetch of this visit has ended. */
    fetchedAtOpen,
    /** The latest detail after a fetch in this visit, before it is deferred. */
    fetchedDetail:
      openedFromPrefetch || (detail.isFetchedAfterMount && !detail.isFetching)
        ? detail.data
        : undefined,
    isLoadingPreviousPage,
    pendingAuthorization: mailbox?.authorization,
    pendingGeneratedAt: mailbox?.generatedAt,
    /** The reader's own sends that the transcript shows before history has them. */
    inlineMessages,
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
      if (conversationId && hasPreviousPage) {
        // A second call joins the read in flight. By default it cancels
        // that read and starts the same read again.
        void history.fetchNextPage({ cancelRefetch: false });
      }
    },
  };
}

/** Reuse the cached detail when the server reports no change. */
export async function readConversationData(
  conversationId: string,
  signal?: AbortSignal,
  previous?: ConversationSnapshot,
  options?: {
    /** Also read the mailbox, before history, in the same request. */
    mailbox?: boolean;
    unreadPage?: boolean;
  },
): Promise<ConversationSnapshot> {
  const query = new URLSearchParams();
  if (options?.unreadPage) query.set("unreadPage", "true");
  if (options?.mailbox) query.set("mailbox", "true");
  // A poll asks only for the events after the cached ones. The unread page
  // needs the latest page, so a read that asks for it reads that page.
  const after = options?.unreadPage ? undefined : previous?.appendCursor;
  if (after) query.set("after", after);
  const search = query.size ? `?${query}` : "";
  const mailboxReadAtMs = Date.now();
  const response = await readDashboardResponse(
    `/api/conversations/${encodeURIComponent(conversationId)}${search}`,
    signal,
    previous?.detailEtag
      ? { [CONVERSATION_DETAIL_VERSION_HEADER]: previous.detailEtag }
      : undefined,
  );
  if (response.status === 304 && previous) return previous;
  if (!options?.mailbox) {
    return withDetailEtag(
      withCachedEvents(
        await readResponseJson(response, conversationDetailReportSchema),
        previous,
      ),
      response,
    );
  }
  const report = await readResponseJson(
    response,
    z.union([
      conversationUnchangedDetailWithMailboxSchema,
      conversationDetailWithMailboxReportSchema,
    ]),
  );
  if (!("unchanged" in report)) {
    return {
      ...withDetailEtag(withCachedEvents(report, previous), response),
      mailboxReadAtMs,
    };
  }
  // Only a request that sent a version can get this answer.
  if (!previous) throw new Error("Unchanged detail without a cached copy");
  return { ...previous, mailbox: report.mailbox, mailboxReadAtMs };
}

/**
 * Put the cached events before the newer events of an `appended` report.
 * The cached detail keeps its cursors: they still point before its events.
 */
function withCachedEvents(
  report: ConversationSnapshot,
  previous: ConversationSnapshot | undefined,
): ConversationSnapshot {
  if (!report.appended) return report;
  // Only a request that sent an `appendCursor` can get this answer.
  if (!previous) throw new Error("Appended detail without a cached copy");
  const { appended: _appended, ...rest } = report;
  const lastSeq = previous.events.at(-1)?.seq ?? -1;
  const firstSeq = previous.events[0]?.seq;
  // Like the server, keep the unread cursor while the reader is behind the
  // first event.
  const behind =
    rest.readPosition !== undefined &&
    firstSeq !== undefined &&
    rest.readPosition.lastReadSeq + 1 < firstSeq;
  return {
    ...rest,
    events: [
      ...previous.events,
      ...report.events.filter((event) => event.seq > lastSeq),
    ],
    ...(previous.previousCursor
      ? { previousCursor: previous.previousCursor }
      : undefined),
    ...(behind && previous.unreadCursor
      ? { unreadCursor: previous.unreadCursor, unreadPage: previous.unreadPage }
      : undefined),
  };
}

function withDetailEtag<T extends ConversationDetailReport>(
  report: T,
  response: Response,
): T & { conversationVersion?: string; detailEtag?: string } {
  return {
    ...report,
    conversationVersion:
      response.headers.get(CONVERSATION_VERSION_HEADER) ?? undefined,
    detailEtag:
      response.headers.get(CONVERSATION_DETAIL_VERSION_HEADER) ?? undefined,
  };
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
