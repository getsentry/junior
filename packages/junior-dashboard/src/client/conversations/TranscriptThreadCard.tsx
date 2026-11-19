import { ChevronRight } from "lucide-react";
import { useContext, type ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../styles";
import type { Conversation, TranscriptViewSubagentPart } from "../types";
import { ChildConversationStatusPill } from "./ChildConversationStatus";
import { usePrefetchConversation } from "./conversationPrefetch";
import { conversationPath } from "./conversationRoutes";
import { FeedThreads } from "./feedThreads";
import { HighlightText } from "./transcriptSearch";
import { formatCompactAge } from "../time";

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
  return (
    <ConversationLinkCard
      conversation={thread}
      conversationId={id}
      timestamp={props.timestamp}
      title={props.part.title ?? props.part.task ?? "Thread"}
    />
  );
}

/**
 * Link one Conversation from a transcript. Its feed row, when the feed has
 * it, gives the current title and status. `note` goes before the age.
 */
export function ConversationLinkCard(props: {
  conversation?: Conversation | undefined;
  conversationId: string;
  note?: ReactNode;
  timestamp?: number | undefined;
  /** Shown when the feed does not have the Conversation. */
  title: string;
}) {
  const { conversation } = props;
  const prefetch = usePrefetchConversation(props.conversationId);
  const title = conversation?.displayTitle ?? props.title;
  const activityAt =
    conversation?.lastSeenAt ??
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
      to={conversationPath(props.conversationId)}
    >
      <span className="min-w-0 flex-1 truncate font-sans text-sm font-medium text-dashboard-text">
        <HighlightText text={title} />
      </span>
      {conversation ? (
        <ChildConversationStatusPill status={conversation.status} />
      ) : null}
      {props.note}
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
