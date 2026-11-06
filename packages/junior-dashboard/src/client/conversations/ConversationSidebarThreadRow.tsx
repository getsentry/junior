import { ChevronRight, CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { memo } from "react";
import { Link } from "react-router";

import {
  conversationDisplayTitle,
  visualStatusForConversation,
} from "../format";
import { Spinner } from "../components/ui/spinner";
import { cn, dashboardDisclosureChevronClass } from "../styles";
import type { Conversation } from "../types";
import { formatCompactAge } from "./conversationAge";
import { usePrefetchConversation } from "./conversationPrefetch";
import { conversationPath } from "./conversationRoutes";

// Line the first level up with the root title, then step in per level. Deep
// trees stop stepping in, so titles keep their width.
const DEPTH_INDENT = ["pl-[2.125rem]", "pl-[3.125rem]", "pl-[4.125rem]"];

/**
 * Render one Thread under its parent in the sidebar. The row shows a status
 * icon, the title, and its age. Threads have no pin, archive, or unread state
 * here: archive applies to everyone, so it stays on the Thread.
 */
export const ConversationSidebarThreadRow = memo(
  function ConversationSidebarThreadRow(props: {
    conversation: Conversation;
    /** 0 for a Thread directly under a root. */
    depth: number;
    selected: boolean;
    /** True when an open review item in this Thread waits on the viewer. */
    waiting: boolean;
  }) {
    const prefetch = usePrefetchConversation(props.conversation.id);
    const status = visualStatusForConversation(props.conversation);
    return (
      <Link
        {...prefetch}
        aria-current={props.selected ? "page" : undefined}
        className={cn(
          "grid min-w-0 grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg py-1 pr-3 text-inherit no-underline transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
          DEPTH_INDENT[Math.min(props.depth, DEPTH_INDENT.length - 1)],
          props.selected && "bg-dashboard-surface-active",
        )}
        to={conversationPath(props.conversation.id)}
      >
        <ThreadStatusIcon status={status} waiting={props.waiting} />
        <span
          className={cn(
            "min-w-0 truncate font-sans text-sm leading-snug",
            props.selected
              ? "font-medium text-dashboard-text"
              : "text-dashboard-text-muted",
          )}
        >
          {conversationDisplayTitle(props.conversation)}
        </span>
        <span className="font-sans text-xs tabular-nums text-dashboard-text-faint">
          {formatCompactAge(props.conversation.lastSeenAt)}
        </span>
      </Link>
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
        "group grid min-w-0 cursor-pointer grid-cols-[0.875rem_minmax(0,1fr)] items-center gap-x-2 rounded-lg py-1 pr-3 text-left font-sans text-xs text-dashboard-text-faint transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
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
 * Mark a Thread with the status that exists today: waiting on the viewer,
 * running, failed, or idle.
 */
function ThreadStatusIcon(props: {
  status: ReturnType<typeof visualStatusForConversation>;
  waiting: boolean;
}) {
  // TODO(dcramer): Show the derived Conversation status (needs input,
  // working, failed, completed) once the list API returns it.
  if (props.waiting) {
    return (
      <CircleAlert
        aria-label="Waiting on you"
        className="size-3.5 text-amber-400"
        role="img"
      />
    );
  }
  if (props.status === "active") {
    return (
      <Spinner
        aria-label="Running"
        className="size-3.5 text-dashboard-text-muted"
      />
    );
  }
  if (props.status === "failed") {
    return (
      <CircleX
        aria-label="Failed"
        className="size-3.5 text-rose-400"
        role="img"
      />
    );
  }
  return (
    <CircleCheck
      aria-label="Idle"
      className="size-3.5 text-dashboard-text-faint"
      role="img"
    />
  );
}
