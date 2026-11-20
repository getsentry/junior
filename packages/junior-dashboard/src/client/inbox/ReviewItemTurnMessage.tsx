import {
  conversationEventPageSchema,
  type ConversationReportEvent,
  type ReviewItemPayload,
} from "@sentry/junior/api/schema";
import { useQuery } from "@tanstack/react-query";

import { agentNamePossessive } from "../agentName";
import { ClampedDisplayText } from "../display-text/DisplayText";
import { fetchDashboardJson } from "../http";

// The last message Junior sent in the Turn, from its start to its end, with
// the people it mentions. The page starts around the Turn's start, so a very
// long Turn can end past it.
function turnLastMessage(
  events: readonly ConversationReportEvent[],
  turnId: string,
): (Pick<ConversationReportEvent, "mentions"> & { text: string }) | undefined {
  let inTurn = false;
  let message: ConversationReportEvent | undefined;
  for (const event of events) {
    const { data } = event;
    if (data.type === "turn_lifecycle" && data.turnId === turnId) {
      if (data.state !== "started") break;
      inTurn = true;
    } else if (data.type === "turn_lifecycle" && inTurn) {
      break;
    } else if (inTurn && data.type === "message" && data.role === "assistant") {
      message = event;
    }
  }
  const text = message?.data.type === "message" && message.data.text?.trim();
  return text ? { mentions: message?.mentions, text } : undefined;
}

/**
 * The last message of the Turn that asked a question, above the question in
 * an expanded Inbox row. Its clamp keeps the form near the top. It reads the
 * page of events around that Turn when the row expands, and shows nothing
 * until then or when the read fails.
 */
export function ReviewItemTurnMessage(props: { item: ReviewItemPayload }) {
  const { addedByConversationId: conversationId, addedByTurnId: turnId } =
    props.item;
  const { data: message } = useQuery({
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
  if (!message) return null;
  const label = `${agentNamePossessive()} message`;
  return (
    <section
      aria-label={label}
      className="grid min-w-0 gap-1 border-l-2 border-dashboard-border pl-3"
    >
      <span className="text-xs text-dashboard-text-muted">{label}</span>
      <ClampedDisplayText
        className="max-w-[80ch] leading-6"
        label={label}
        lines={4}
        mentions={message.mentions}
        text={message.text}
      />
    </section>
  );
}
