import { Archive, ChevronRight } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useState } from "react";
import { Link } from "react-router";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import {
  conversationDisplayTitle,
  visualStatusForConversation,
} from "../format";
import { cn, dashboardDisclosureChevronClass } from "../styles";
import type { Conversation } from "../types";
import { ArchiveChildDialog } from "./ArchiveChildDialog";
import {
  ChildConversationStatusIcon,
  childConversationStatus,
} from "./ChildConversationStatus";
import { formatCompactAge } from "./conversationAge";
import { useArchiveConversation } from "./conversationArchive";
import {
  prefetchConversationDetail,
  usePrefetchConversation,
} from "./conversationPrefetch";
import { conversationPath } from "./conversationRoutes";
import {
  conversationDetailQueryKey,
  type ConversationSnapshot,
} from "./queries";
import {
  ROW_ACTION_BUTTON_CLASS,
  ROW_ACTIONS_FADE_CLASS,
  ROW_ACTIONS_REVEAL_CLASS,
} from "./sidebarRowActions";

// Line the first level up with the root title, then step in per level. Deep
// trees stop stepping in, so titles keep their width.
const DEPTH_INDENT = ["pl-[2.25rem]", "pl-[3.25rem]", "pl-[4.25rem]"];

/**
 * Render one Thread under its parent in the sidebar. The row shows a status
 * icon, the title, and its age. A running Thread shows only its spinner and
 * no age, so the feed token skips its activity. Participants can archive it
 * from the row. A Thread archive applies to everyone, so it asks first.
 * Threads have no pin or unread state here, and archived Threads leave the
 * sidebar, so the row has no restore.
 */
export const ConversationSidebarThreadRow = memo(
  function ConversationSidebarThreadRow(props: {
    conversation: Conversation;
    /** 0 for a Thread directly under a root. */
    depth: number;
    onArchiveError(conversation: Conversation, wasArchiving: boolean): void;
    onArchived(conversation: Conversation): void;
    /** Runs before the archive, so its result shows. */
    onRowAction?(): void;
    selected: boolean;
    /** True when an open review item in this Thread waits on the viewer. */
    waiting: boolean;
  }) {
    const prefetch = usePrefetchConversation(props.conversation.id);
    const archive = useArchiveConversation(props.conversation.id, {
      onError: () => props.onArchiveError(props.conversation, true),
      onSuccess: (archivedAt) => {
        if (archivedAt) props.onArchived(props.conversation);
      },
    });
    const queryClient = useQueryClient();
    const [confirmArchive, setConfirmArchive] = useState<{
      hasChildren: boolean;
    }>();
    // The feed lists only visible Threads, so the detail tells whether the
    // archive takes child conversations with it. A hover has usually read
    // it already.
    const openArchiveConfirm = async () => {
      await prefetchConversationDetail(queryClient, props.conversation.id);
      const detail = queryClient.getQueryData<ConversationSnapshot>(
        conversationDetailQueryKey(props.conversation.id),
      );
      setConfirmArchive({
        hasChildren: detail
          ? Boolean(detail.childAgentTotals?.count)
          : Boolean(props.conversation.threads?.length),
      });
    };
    const title = conversationDisplayTitle(props.conversation);
    // The API takes an archive only from participants.
    const participant = props.conversation.isParticipant;
    return (
      <div
        className={cn(
          "group relative min-w-0 rounded-lg transition-colors [--row-actions-width:2.25rem] hover:bg-dashboard-fill-hover",
          props.selected && "bg-dashboard-surface-active",
        )}
      >
        <Link
          {...prefetch}
          aria-current={props.selected ? "page" : undefined}
          className={cn(
            "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg py-1 pr-2 text-inherit no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
            DEPTH_INDENT[Math.min(props.depth, DEPTH_INDENT.length - 1)],
            participant && `max-sm:pr-10 ${ROW_ACTIONS_FADE_CLASS}`,
          )}
          to={conversationPath(props.conversation.id)}
        >
          <ChildConversationStatusIcon
            status={childConversationStatus(props.conversation, props.waiting)}
          />
          <span
            className={cn(
              "min-w-0 truncate font-sans text-sm leading-snug",
              props.selected
                ? "font-medium text-dashboard-text"
                : "text-dashboard-text-muted",
            )}
          >
            {title}
          </span>
          {visualStatusForConversation(props.conversation) ===
          "active" ? null : (
            <span
              className={cn(
                "font-sans text-xs tabular-nums text-dashboard-text-faint",
                // The archive button takes the age's place. The fade alone
                // leaves part of the age showing beside the one button.
                participant &&
                  "sm:group-hover:invisible sm:group-focus-within:invisible",
              )}
            >
              {formatCompactAge(props.conversation.lastSeenAt)}
            </span>
          )}
        </Link>
        {participant ? (
          <div
            className={cn(
              "absolute inset-y-0 right-1.5 items-center",
              ROW_ACTIONS_REVEAL_CLASS,
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label={`Archive ${title}`}
                    className={ROW_ACTION_BUTTON_CLASS}
                    disabled={archive.isPending}
                    onClick={() => void openArchiveConfirm()}
                    type="button"
                  >
                    <Archive aria-hidden="true" size={14} />
                  </button>
                }
              />
              <TooltipContent size="compact">Archive</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        {confirmArchive ? (
          <ArchiveChildDialog
            hasChildren={confirmArchive.hasChildren}
            onClose={() => setConfirmArchive(undefined)}
            onConfirm={() => {
              setConfirmArchive(undefined);
              props.onRowAction?.();
              archive.mutate({
                archived: true,
                lastSeenAt: props.conversation.lastSeenAt,
              });
            }}
          />
        ) : null}
      </div>
    );
  },
);

/** Show or hide the Threads that the sidebar left out under one root. */
export function ConversationSidebarThreadToggle(props: {
  expanded: boolean;
  hiddenCount: number;
  onToggle(): void;
}) {
  return (
    <button
      aria-expanded={props.expanded}
      className={cn(
        "group grid min-w-0 cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-3 rounded-lg py-1 pr-2 text-left font-sans text-xs text-dashboard-text-faint transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
        DEPTH_INDENT[0],
      )}
      onClick={props.onToggle}
      type="button"
    >
      <ChevronRight
        aria-hidden="true"
        className={dashboardDisclosureChevronClass}
      />
      {props.expanded ? "Show fewer" : `Show ${props.hiddenCount} more`}
    </button>
  );
}
