import {
  mutationOptions,
  type QueryClient,
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ConversationDetailReport,
  ConversationFeed,
  ConversationFeedItem,
  ConversationSummaryReport,
} from "@sentry/junior/api/schema";
import { archiveConversationResponseSchema } from "@sentry/junior/api/schema";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";

import { buildConversations } from "../format";
import { patch } from "../http";
import type { Conversation } from "../types";
import {
  conversationDetailQueryKey,
  type ConversationSnapshot,
} from "./queries";

/** Apply archive marks to one feed row, at any depth of nested Threads. */
function markFeedConversation(
  items: ConversationFeedItem[],
  conversationId: string,
  marks: Partial<ConversationFeedItem>,
): ConversationFeedItem[] {
  return items.map((item) =>
    item.conversationId === conversationId
      ? { ...item, ...marks }
      : item.threads
        ? {
            ...item,
            threads: markFeedConversation(item.threads, conversationId, marks),
          }
        : item,
  );
}

/** Find a feed row at any depth, with the row whose `threads` hold it. */
function findFeedRow(
  items: ConversationFeedItem[],
  conversationId: string,
  parentConversationId?: string,
): { parentConversationId?: string; row: ConversationFeedItem } | undefined {
  for (const item of items) {
    if (item.conversationId === conversationId) {
      return { parentConversationId, row: item };
    }
    const nested =
      item.threads &&
      findFeedRow(item.threads, conversationId, item.conversationId);
    if (nested) return nested;
  }
  return undefined;
}

/** Put a restored Thread back under the feed row that held it. */
function withRestoredThread(
  items: ConversationFeedItem[],
  parentConversationId: string,
  thread: ConversationFeedItem,
): ConversationFeedItem[] {
  return items.map((item) =>
    item.conversationId === parentConversationId
      ? {
          ...item,
          threads: [...(item.threads ?? []), thread].sort((a, b) =>
            b.lastSeenAt.localeCompare(a.lastSeenAt),
          ),
        }
      : item.threads
        ? {
            ...item,
            threads: withRestoredThread(
              item.threads,
              parentConversationId,
              thread,
            ),
          }
        : item,
  );
}

/**
 * A child archive also writes its descendants, which show in other detail
 * pages and in their ancestors' child-agents reports.
 */
function isTreeArchiveRead({ queryKey }: { queryKey: readonly unknown[] }) {
  return (
    queryKey[0] === "conversation" &&
    (queryKey[2] === "detail" || queryKey[2] === "agents")
  );
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
  conversation: ConversationFeedItem;
  feedQueryHashes: string[];
  /** Set for a nested Thread: the feed row whose `threads` held it. */
  parentConversationId?: string;
};

const archiveConversationMutationKey = [
  "dashboard",
  "archive-conversation",
] as const;

type ArchiveConversationVariables = {
  /**
   * Child Conversations only: also archive or restore every descendant. The
   * dashboard sends it for every child, so it also marks a child archive.
   */
  applyToChildren?: boolean;
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
        // A nested Thread is restored under its parent by the cache write, not
        // as a top-level row.
        conversation: context?.archivedSnapshot?.parentConversationId
          ? undefined
          : context?.archivedSnapshot?.conversation,
        conversationId:
          typeof conversationId === "string" ? conversationId : "",
      } satisfies PendingArchiveConversationUpdate;
    },
  });
}

/**
 * Router state for home after a conversation archives itself. Home reports
 * the background archive result, because the conversation page is gone.
 */
export type ArchivedFromConversationState = {
  archivedConversation: Conversation;
};

/** Read the newest archive or restore status for one conversation. */
function useLatestArchiveStatus(conversationId: string | undefined) {
  const statuses = useMutationState({
    filters: {
      exact: true,
      mutationKey: [...archiveConversationMutationKey, conversationId],
    },
    select: (mutation) => mutation.state.status,
  });
  // The mutation cache keeps insertion order, so the last entry is newest.
  return conversationId ? statuses.at(-1) : undefined;
}

/**
 * Report an archive started on the conversation page, which navigated home
 * before the request finished.
 */
export function useConversationPageArchiveResult(
  onArchived: (conversation: Conversation) => void,
  onArchiveError: (conversation: Conversation, wasArchiving: boolean) => void,
) {
  const location = useLocation();
  const navigate = useNavigate();
  const conversation = (location.state as ArchivedFromConversationState | null)
    ?.archivedConversation;
  const status = useLatestArchiveStatus(conversation?.id);
  useEffect(() => {
    if (!conversation || (status !== "success" && status !== "error")) return;
    if (status === "success") onArchived(conversation);
    else onArchiveError(conversation, true);
    // Clear the state so a reload or a later restore does not report again.
    navigate(
      { hash: location.hash, search: location.search },
      { replace: true, state: null },
    );
  }, [
    conversation,
    location.hash,
    location.search,
    navigate,
    onArchiveError,
    onArchived,
    status,
  ]);
}

type ArchiveConversationOptions = {
  onError?(): void;
  onSuccess?(archivedAt: string | null): void;
};

/** Archive or restore one conversation with an immediate reversible cache update. */
export function useArchiveConversation(
  conversationId: string,
  options?: ArchiveConversationOptions,
) {
  const queryClient = useQueryClient();
  return useMutation(
    archiveConversationMutationOptions(queryClient, conversationId, options),
  );
}

/**
 * Build the archive mutation for callers that outlive a component, such as a
 * toast action. The shared mutation key keeps pending-state readers in sync.
 */
export function archiveConversationMutationOptions(
  queryClient: QueryClient,
  conversationId: string,
  options?: ArchiveConversationOptions,
) {
  return mutationOptions({
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
      // Match the API: a child archive is shared. A root archive also unpins
      // and marks it read; restore keeps the read state, because auto-archive
      // does not mark it read.
      const viewerMarks = args.applyToChildren
        ? { childArchivedAt: archivedAt }
        : args.archived
          ? { archivedAt, pinnedAt: null, unread: undefined }
          : { archivedAt };
      // Snapshot from any loaded feed, including archived-only fixtures that
      // were never archived through this client session.
      const snapshot =
        buildArchivedConversationSnapshot(previousFeeds, conversationId) ??
        previousArchivedSnapshot;
      const archivedSnapshot =
        snapshot && args.archived
          ? {
              ...snapshot,
              conversation: { ...snapshot.conversation, unread: undefined },
            }
          : snapshot;

      previousFeeds.forEach(([queryKey, feed]) => {
        if (!feed) return;
        const conversationExists = Boolean(
          findFeedRow(feed.conversations, conversationId),
        );
        const feedStatus = conversationFeedStatus(queryKey);
        const shouldRestore =
          !args.archived &&
          !conversationExists &&
          Boolean(archivedSnapshot) &&
          feedStatus !== "archived";
        const restoreParentId = archivedSnapshot?.parentConversationId;
        const conversations = !shouldRestore
          ? markFeedConversation(
              feed.conversations,
              conversationId,
              viewerMarks,
            )
          : restoreParentId
            ? withRestoredThread(feed.conversations, restoreParentId, {
                ...archivedSnapshot!.conversation,
                childArchivedAt: null,
              })
            : [
                ...feed.conversations,
                // The archive cleared the pin, so the restored row is unpinned.
                {
                  ...archivedSnapshot!.conversation,
                  archivedAt: null,
                  pinnedAt: null,
                },
              ].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
        queryClient.setQueryData<ConversationFeed>(queryKey, {
          ...feed,
          // The feed nests Threads under their root, so hide an archived
          // Thread there too.
          conversations: args.archived
            ? withoutThreads(
                conversations,
                (thread) => thread.conversationId === conversationId,
              )
            : conversations,
        });
      });
      queryClient.setQueryData<ConversationSnapshot>(
        detailQueryKey,
        (detail) =>
          detail
            ? { ...detail, ...viewerMarks, detailEtag: undefined }
            : detail,
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
                ...(detail.kind === "root"
                  ? { archivedAt: result.archivedAt }
                  : { childArchivedAt: result.archivedAt }),
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
    onSettled: async (_result, _error, args) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["dashboard", "conversations"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["dashboard", "locations"],
        }),
        queryClient.invalidateQueries({ queryKey: ["dashboard", "people"] }),
        queryClient.invalidateQueries(
          args.applyToChildren
            ? { predicate: isTreeArchiveRead }
            : {
                exact: true,
                queryKey: conversationDetailQueryKey(conversationId),
              },
        ),
      ]);
    },
  });
}

function buildArchivedConversationSnapshot(
  feeds: Array<[readonly unknown[], ConversationFeed | undefined]>,
  conversationId: string,
): ArchivedConversationSnapshot | undefined {
  let found: ReturnType<typeof findFeedRow>;
  const feedQueryHashes: string[] = [];
  for (const [queryKey, feed] of feeds) {
    const feedRow = feed && findFeedRow(feed.conversations, conversationId);
    if (!feedRow) continue;
    found ??= feedRow;
    feedQueryHashes.push(JSON.stringify(queryKey));
  }
  return found
    ? {
        conversation: found.row,
        feedQueryHashes,
        parentConversationId: found.parentConversationId,
      }
    : undefined;
}

/**
 * Show a pending archive change on the conversation page before the server
 * confirms it.
 */
export function applyPendingArchiveUpdate(
  conversation: Conversation | undefined,
  update: PendingArchiveConversationUpdate | undefined,
): Conversation | undefined {
  const updatedConversation =
    conversation ??
    (update?.conversation
      ? buildConversations([update.conversation])[0]
      : undefined);
  if (!updatedConversation || !update) return updatedConversation;
  const archivedAt = update.archived
    ? (conversationArchivedAt(updatedConversation) ??
      updatedConversation.lastSeenAt)
    : null;
  return updatedConversation.kind === "root"
    ? { ...updatedConversation, archivedAt }
    : { ...updatedConversation, childArchivedAt: archivedAt };
}

/** A root archive is the viewer's own. A child archive is shared. */
export function conversationArchivedAt(conversation: Conversation | undefined) {
  return conversation?.kind === "root"
    ? conversation.archivedAt
    : conversation?.childArchivedAt;
}

/** Drop matching Threads from the nested `threads` of rows, at any depth. */
export function withoutThreads<T extends { threads?: T[] }>(
  rows: T[],
  isDropped: (thread: T) => boolean,
): T[] {
  return rows.map((row) => {
    if (!row.threads) return row;
    const { threads, ...rest } = row;
    const kept = withoutThreads(
      threads.filter((thread) => !isDropped(thread)),
      isDropped,
    );
    return (kept.length ? { ...rest, threads: kept } : rest) as T;
  });
}
