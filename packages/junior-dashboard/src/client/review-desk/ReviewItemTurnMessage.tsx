import {
  conversationEventPageSchema,
  type ConversationReportEvent,
  type ReviewItemPayload,
} from "@sentry/junior/api/schema";
import { useQuery } from "@tanstack/react-query";

import { ClampedDisplayText } from "../display-text/DisplayText";
import { fetchDashboardJson } from "../http";

// The last message Junior sent in the Turn, from its start to its end. The
// page starts around the Turn's start, so a very long Turn can end past it.
function turnLastMessage(
  events: readonly ConversationReportEvent[],
  turnId: string,
): string | undefined {
  let inTurn = false;
  let text: string | undefined;
  for (const { data } of events) {
    if (data.type === "turn_lifecycle" && data.turnId === turnId) {
      if (data.state !== "started") break;
      inTurn = true;
    } else if (data.type === "turn_lifecycle" && inTurn) {
      break;
    } else if (inTurn && data.type === "message" && data.role === "assistant") {
      text = data.text;
    }
  }
  return text?.trim() || undefined;
}

/**
 * The last message of the Turn that asked a question, under the question in
 * an expanded Inbox row. It reads the page of events around that Turn when
 * the row expands, and shows nothing until then or when the read fails.
 */
export function ReviewItemTurnMessage(props: { item: ReviewItemPayload }) {
  const { addedByConversationId: conversationId, addedByTurnId: turnId } =
    props.item;
  const { data: text } = useQuery({
    enabled: Boolean(turnId),
    // Not under ["dashboard", "conversations"]: every key there is a feed,
    // and the feed updates read each one as a feed.
    queryKey: ["dashboard", "conversation-turn", conversationId, turnId],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationEventPageSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/events?${new URLSearchParams({ turn: turnId! })}`,
        signal,
      ),
    retry: false,
    select: (page) => turnLastMessage(page.events, turnId!),
    staleTime: 60_000,
  });
  if (!text) return null;
  return (
    <section
      aria-label="Junior's message"
      className="grid min-w-0 gap-1 border-l-2 border-dashboard-border pl-3"
    >
      <span className="text-xs text-dashboard-text-muted">
        Junior's message
      </span>
      <ClampedDisplayText
        className="max-w-[80ch] leading-6"
        label="Junior's message"
        lines={6}
        text={text}
      />
    </section>
  );
}
