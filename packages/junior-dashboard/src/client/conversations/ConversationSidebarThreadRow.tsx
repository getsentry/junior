import { Archive, ChevronRight } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useState } from "react";
import { Link } from "react-router";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { conversationDisplayTitle } from "../format";
import { Spinner } from "../components/ui/spinner";
import { cn, dashboardDisclosureChevronClass } from "../styles";
import type { Conversation } from "../types";
import { ArchiveChildDialog } from "./ArchiveChildDialog";
import { ChildConversationStatusIcon } from "./ChildConversationStatus";
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
import { formatCompactAge } from "../time";
import { conversationTurnIsActive } from "./turnActivity";

// Threads start on the row title's left edge, 2rem in, then step in per
// level. Deep trees stop stepping in, so titles keep their width. The glyph
// column and gap match the sidebar rows (`sidebarGrid`).
const DEPTH_INDENT = ["pl-7", "pl-11", "pl-15"];
const ROW_GRID = "grid-cols-[1rem_minmax(0,1fr)_auto] gap-x-3 pr-2";
const TOGGLE_GRID = "grid-cols-[1rem_minmax(0,1fr)] gap-x-3 pr-2";

/**
 * Render one Thread under its parent in the sidebar. The row shows a status
 * icon, the title, and its age. A running Thread shows only its spinner and
 * no age, so the feed token skips its activity. Participants can archive it
 * from the row. A Thread archive applies to everyone, so it asks first.
 * Threads have no pin here, and archived Threads leave the sidebar, so the
 * row has no restore.
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
            "grid min-w-0 items-center rounded-lg py-1 text-inherit no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
            ROW_GRID,
            DEPTH_INDENT[Math.min(props.depth, DEPTH_INDENT.length - 1)],
            participant && `max-sm:pr-10 ${ROW_ACTIONS_FADE_CLASS}`,
          )}
          to={conversationPath(props.conversation.id)}
        >
          <ChildConversationStatusIcon status={props.conversation.status} />
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
          {conversationTurnIsActive(props.conversation) ? (
            // The icon follows `status`. A running Thread that needs input
            // shows the alert there, so it shows that it runs here.
            props.conversation.status === "working" ? null : (
              <Spinner
                aria-label="Running"
                className="size-3.5 justify-self-end text-dashboard-text-muted"
              />
            )
          ) : (
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
        "group grid min-w-0 cursor-pointer items-center rounded-lg py-1 text-left font-sans text-xs text-dashboard-text-faint transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
        TOGGLE_GRID,
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

/**
 * Say how many of a root's Threads the feed left out. The root's own page
 * lists them all.
 */
export function ConversationSidebarThreadsOmitted(props: { count: number }) {
  return (
    <p
      className={cn(
        "grid min-w-0 py-1 font-sans text-xs text-dashboard-text-faint",
        TOGGLE_GRID,
        DEPTH_INDENT[0],
      )}
    >
      <span className="col-start-2">+{props.count} more</span>
    </p>
  );
}
