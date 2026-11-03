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
import { onlyRecordsReviewItemChanges } from "./reviewItemFormat";

/** Messages before the item that the excerpt shows. */
const BEFORE_COUNT = 3;
/** Messages after the item that the excerpt shows. */
const AFTER_COUNT = 3;

/**
 * Pick the messages nearest the time an item was added. Only messages show:
 * the tool call that added the item would repeat its card. For a closed item,
 * messages from its close on do not show: the card already has the answer.
 */
function conversationExcerpt(
  events: readonly ConversationReportEvent[],
  item: Pick<ReviewItemPayload, "closedAt" | "createdAt">,
): { after: ConversationReportEvent[]; before: ConversationReportEvent[] } {
  const askedAt = Date.parse(item.createdAt);
  const closedAt = item.closedAt ? Date.parse(item.closedAt) : Infinity;
  // Changes to items show on their cards, not as context for this one.
  const messages = events.filter(
    (event) =>
      event.data.type === "message" &&
      event.data.role !== "system" &&
      !onlyRecordsReviewItemChanges(event.data),
  );
  return {
    after: messages
      .filter((event) => {
        const at = Date.parse(event.createdAt);
        return at > askedAt && at < closedAt;
      })
      .slice(0, AFTER_COUNT),
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
 * Show the messages around the point where the agent added an item, split
 * where it asked. Returns `fallback` when the viewer cannot read its messages.
 */
export function ReviewItemContext(props: {
  fallback: ReactNode;
  item: ReviewItemPayload;
}) {
  const detail = useConversationData(props.item.addedByConversationId);
  const data = detail.data;
  const events = data?.events;
  const excerpt = useMemo(
    () => (events ? conversationExcerpt(events, props.item) : undefined),
    [events, props.item],
  );
  // The first page holds the newest events. Load earlier pages until the
  // page reaches the time the item was added, or history ends. Until then
  // the loaded messages after the ask are not the first ones, so the
  // excerpt waits.
  const loadPreviousPageRef = useRef(detail.loadPreviousPage);
  loadPreviousPageRef.current = detail.loadPreviousPage;
  const oldest = events?.[0]?.createdAt;
  // Redacted or expired history has no messages to wait for.
  const available = data?.eventHistory.status === "available";
  const missingEarlier =
    available &&
    oldest !== undefined &&
    Date.parse(oldest) > Date.parse(props.item.createdAt) &&
    detail.hasPreviousPage;
  const loadEarlier =
    missingEarlier && !detail.isLoadingPreviousPage && !detail.historyError;
  useEffect(() => {
    if (loadEarlier) loadPreviousPageRef.current();
  }, [loadEarlier, oldest]);

  if (detail.isPending || (missingEarlier && !detail.historyError)) {
    return <TranscriptLoading />;
  }
  if (
    !data ||
    !excerpt ||
    !available ||
    missingEarlier ||
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
