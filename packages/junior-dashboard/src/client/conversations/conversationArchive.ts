import {
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ConversationDetailReport,
  ConversationFeed,
  ConversationSummaryReport,
} from "@sentry/junior/api/schema";
import { archiveConversationResponseSchema } from "@sentry/junior/api/schema";

import { patch } from "../http";
import {
  conversationDetailQueryKey,
  type ConversationSnapshot,
} from "./queries";

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
