import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type {
  ConversationReportEvent,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../agentName";
import { ConversationTranscriptView } from "../conversations/ConversationTranscript";
import { TranscriptLoading } from "../conversations/TranscriptLoading";
import { useConversationData } from "../conversations/queries";
import type { ConversationTranscript } from "../types";

/** Messages before the item that the excerpt shows. */
const BEFORE_COUNT = 3;
/** Messages after the item that the excerpt shows, newest last. */
const AFTER_COUNT = 8;

/**
 * Split the messages of a Conversation at the time an item was added. Only
 * messages show: the tool call that added the item would repeat its card.
 */
function conversationExcerpt(
  events: readonly ConversationReportEvent[],
  itemCreatedAt: string,
): { after: ConversationReportEvent[]; before: ConversationReportEvent[] } {
  const askedAt = Date.parse(itemCreatedAt);
  const messages = events.filter(
    (event) => event.data.type === "message" && event.data.role !== "system",
  );
  return {
    after: messages
      .filter((event) => Date.parse(event.createdAt) > askedAt)
      .slice(-AFTER_COUNT),
    before: messages
      .filter((event) => Date.parse(event.createdAt) <= askedAt)
      .slice(-BEFORE_COUNT),
  };
}

function Excerpt(props: {
  conversation: ConversationTranscript;
  events: ConversationReportEvent[];
}) {
  const conversation = useMemo(
    () => ({ ...props.conversation, events: props.events }),
    [props.conversation, props.events],
  );
  return <ConversationTranscriptView conversation={conversation} />;
}

/**
 * Show the end of the Conversation that added an item, split where the agent
 * asked. Returns `fallback` when the viewer cannot read its messages.
 */
export function ReviewItemContext(props: {
  fallback: ReactNode;
  item: ReviewItemPayload;
}) {
  const detail = useConversationData(props.item.addedByConversationId);
  const data = detail.data;
  const events = data?.events;
  const excerpt = useMemo(
    () =>
      events ? conversationExcerpt(events, props.item.createdAt) : undefined,
    [events, props.item.createdAt],
  );
  // The first page holds the newest events. Load earlier pages until the
  // page reaches the time the item was added, or history ends.
  const loadPreviousPageRef = useRef(detail.loadPreviousPage);
  loadPreviousPageRef.current = detail.loadPreviousPage;
  const oldest = events?.[0]?.createdAt;
  const loadEarlier =
    oldest !== undefined &&
    Date.parse(oldest) > Date.parse(props.item.createdAt) &&
    detail.hasPreviousPage &&
    !detail.isLoadingPreviousPage &&
    !detail.historyError;
  useEffect(() => {
    if (loadEarlier) loadPreviousPageRef.current();
  }, [loadEarlier, oldest]);

  if (detail.isPending) return <TranscriptLoading />;
  if (
    !data ||
    !excerpt ||
    data.eventHistory.status !== "available" ||
    excerpt.before.length + excerpt.after.length === 0
  ) {
    return props.fallback;
  }
  return (
    <div className="grid min-w-0 gap-2">
      {excerpt.before.length > 0 ? (
        <Excerpt conversation={data} events={excerpt.before} />
      ) : null}
      {excerpt.after.length > 0 ? (
        <>
          <div className="flex items-center gap-3 py-1 font-sans text-xs font-medium text-dashboard-accent-text">
            <span className="h-px flex-1 bg-dashboard-accent/30" />
            New since {getDashboardAgentName()} asked
            <span className="h-px flex-1 bg-dashboard-accent/30" />
          </div>
          <Excerpt conversation={data} events={excerpt.after} />
        </>
      ) : null}
    </div>
  );
}
