import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, ExternalLink, Eye, LockKeyhole } from "lucide-react";
import {
  conversationWatchesReportSchema,
  type ConversationWatch,
  type ConversationWatchesReport,
} from "@sentry/junior/api/schema";

import { DropdownMenuItem } from "../components/ui/dropdown-menu";
import { deleteDashboardResource } from "../http";
import { revalidatedJsonQuery } from "../revalidation";
import { formatRelativeTime, formatTime } from "../time";
import { useConversationChildAgents } from "./ConversationChildAgents";
import { conversationSideReadQueryKey } from "./conversationSideReads";
import {
  DetailsRow,
  DetailsRowLine,
  DetailsRowMenu,
  DetailsSection,
} from "./DetailsList";

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

/**
 * List what one Conversation waits on: its own Watches and Timers, each with
 * when it fires or expires. A child's Watch shows in that child's menu
 * instead, unless the child is not listed, such as a grandchild.
 */
export function ConversationWaitingOn(props: {
  canEdit: boolean;
  conversationId: string;
}) {
  const children =
    useConversationChildAgents(props.conversationId).data?.agents ?? [];
  const watches =
    useConversationWatches(props.conversationId).data?.watches ?? [];
  const listed = new Set(children.map((child) => child.conversationId));
  const own = watches.filter(
    (watch) =>
      !watch.childAgent || !listed.has(watch.childAgent.conversationId),
  );
  return (
    <DetailsSection
      rows={own.map((watch) => (
        <WatchRow
          canEdit={props.canEdit}
          conversationId={props.conversationId}
          key={watch.id}
          watch={watch}
        />
      ))}
      title="Waiting on"
    />
  );
}

function WatchRow(props: {
  canEdit: boolean;
  conversationId: string;
  watch: ConversationWatch;
}) {
  const { watch } = props;
  const cancel = useCancelConversationWatch(props.conversationId);
  const title = watchTitle(watch);
  // A Timer has the clock. A Watch for an Event has the sidebar's eye.
  const timer = Boolean(watch.firesAt);
  const Icon = watch.redacted ? LockKeyhole : timer ? Clock : Eye;
  const at = watch.firesAt ?? watch.expiresAt;
  const verb = timer ? "Fires" : "Expires";
  return (
    <DetailsRow
      icon={
        <Icon
          aria-label={watch.redacted ? "Private" : timer ? "Timer" : "Watching"}
          className="size-4 text-dashboard-text-muted"
          role="img"
        />
      }
      menu={
        props.canEdit ? (
          <DetailsRowMenu label={`Change ${title}`}>
            <DropdownMenuItem onClick={() => cancel.mutate(watch)}>
              Cancel
            </DropdownMenuItem>
          </DetailsRowMenu>
        ) : null
      }
      title={
        <>
          {title}
          {watch.url ? (
            <a
              aria-label={`Open ${title}`}
              className="ml-1 inline-grid size-5 place-items-center rounded-md align-top text-dashboard-text-muted hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
              href={watch.url}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          ) : null}
        </>
      }
    >
      <DetailsRowLine>
        {/* The exact time shows on hover. */}
        <time
          dateTime={at}
          title={`${verb} ${formatTime(at, { dateStyle: "medium", timeStyle: "short" })}`}
        >
          {verb} {formatRelativeTime(at)}
        </time>
      </DetailsRowLine>
    </DetailsRow>
  );
}
