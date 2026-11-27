import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  conversationWatchesReportSchema,
  type ConversationWatch,
  type ConversationWatchesReport,
} from "@sentry/junior/api/schema";

import { DropdownMenuItem } from "../components/ui/dropdown-menu";
import { deleteDashboardResource } from "../http";
import { revalidatedJsonQuery } from "../revalidation";
import { conversationSideReadQueryKey } from "./conversationSideReads";

/** Load the active Watches that one Conversation owns. */
export function useConversationWatches(conversationId: string) {
  return useQuery({
    queryFn: revalidatedJsonQuery(
      conversationWatchesReportSchema,
      `/api/conversations/${encodeURIComponent(conversationId)}/watches`,
    ),
    queryKey: conversationSideReadQueryKey(conversationId, "watches"),
    retry: false,
  });
}

/**
 * Cancel one Watch. Only the Conversation that created a Watch cancels it,
 * so a child agent's Watch goes through the child. The Watch leaves this
 * Conversation's list at once; a failed cancel brings it back.
 */
export function useCancelConversationWatch(conversationId: string) {
  const queryClient = useQueryClient();
  const queryKey = conversationSideReadQueryKey(conversationId, "watches");
  return useMutation({
    mutationFn: (watch: ConversationWatch) =>
      deleteDashboardResource(
        `/api/conversations/${encodeURIComponent(watch.childAgent?.conversationId ?? conversationId)}/watches/${encodeURIComponent(watch.id)}`,
      ),
    onMutate: async (watch) => {
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<ConversationWatchesReport>(
        queryKey,
        (report) =>
          report && {
            ...report,
            watches: report.watches.filter(
              (candidate) => candidate.id !== watch.id,
            ),
          },
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

/** Name a Watch by what it waits for, or by its resource when private. */
function watchTitle(watch: ConversationWatch): string {
  const resource = `${watch.namespace} ${watch.resourceType.replaceAll("_", " ")}`;
  return watch.intent ?? watch.label ?? `Private ${resource}`;
}

/** Offer Cancel for each Watch that a child owns, in the child's menu. */
export function WatchCancelItems(props: {
  conversationId: string;
  watches: readonly ConversationWatch[];
}) {
  const cancel = useCancelConversationWatch(props.conversationId);
  return props.watches.map((watch) => (
    <DropdownMenuItem key={watch.id} onClick={() => cancel.mutate(watch)}>
      Cancel {watchTitle(watch)}
    </DropdownMenuItem>
  ));
}
