import { ChevronRight } from "lucide-react";
import { useContext } from "react";
import { Link } from "react-router";

import { useWaitingConversations } from "../review-desk/queries";
import { cn } from "../styles";
import type { TranscriptViewSubagentPart } from "../types";
import {
  ChildConversationStatusPill,
  childConversationStatus,
} from "./ChildConversationStatus";
import { formatCompactAge } from "./conversationAge";
import { usePrefetchConversation } from "./conversationPrefetch";
import { conversationPath } from "./conversationRoutes";
import { FeedThreads } from "./feedThreads";
import { HighlightText } from "./transcriptSearch";

/**
 * Link a Thread that the parent started to its page: title, status, and age.
 * A Thread in the feed shows its own title and the status of its sidebar
 * row. A Thread the feed leaves out, such as an archived one, shows what the
 * parent recorded and no status.
 */
export function TranscriptThreadCard(props: {
  part: TranscriptViewSubagentPart;
  timestamp?: number | undefined;
}) {
  const id = props.part.childConversationId;
  const thread = useContext(FeedThreads).get(id);
  const waiting = useWaitingConversations().has(id);
  const prefetch = usePrefetchConversation(id);
  const title =
    thread?.displayTitle ?? props.part.title ?? props.part.task ?? "Thread";
  const activityAt =
    thread?.lastSeenAt ??
    (typeof props.timestamp === "number"
      ? new Date(props.timestamp).toISOString()
      : undefined);
  return (
    <Link
      {...prefetch}
      className={cn(
        "group/thread flex w-full min-w-0 max-w-[37.5rem] items-center gap-2.5 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel px-3 py-2 text-inherit no-underline transition-colors",
        "hover:border-dashboard-border-emphasis hover:bg-dashboard-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
      )}
      to={conversationPath(id)}
    >
      <span className="min-w-0 flex-1 truncate font-sans text-sm font-medium text-dashboard-text">
        <HighlightText text={title} />
      </span>
      {thread ? (
        <ChildConversationStatusPill
          status={childConversationStatus(thread, waiting)}
        />
      ) : null}
      {activityAt ? (
        <span className="shrink-0 font-sans text-xs tabular-nums text-dashboard-text-faint">
          {formatCompactAge(activityAt)}
        </span>
      ) : null}
      <ChevronRight
        aria-hidden="true"
        className="size-4 shrink-0 text-dashboard-text-faint transition-colors group-hover/thread:text-dashboard-text"
      />
    </Link>
  );
}
