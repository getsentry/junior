import type {
  ConversationDetailReport,
  ConversationEventPage,
  ConversationReportEvent,
} from "@sentry/junior/api/schema";

/** Build the current transcript from independently cached REST resources. */
export function buildConversationTranscript(
  detail: ConversationDetailReport,
  historyPages: ConversationEventPage[],
): ConversationDetailReport {
  if (detail.eventHistory.status !== "available") {
    return withoutModelUsage(detail);
  }

  const restrictedHistory = historyPages.find(
    (page) => page.eventHistory.status !== "available",
  );
  if (restrictedHistory) {
    return withoutModelUsage({
      ...detail,
      eventHistory: restrictedHistory.eventHistory,
      events: restrictedHistory.events,
      previousCursor: restrictedHistory.previousCursor,
    });
  }

  const lastHistoryPage = historyPages.at(-1);
  return {
    ...detail,
    events: orderedEvents([
      ...historyPages.flatMap((page) => page.events),
      ...detail.events,
    ]),
    previousCursor: lastHistoryPage
      ? lastHistoryPage.previousCursor
      : detail.previousCursor,
  };
}

/** Report whether a history resource observed a different visibility state. */
export function conversationHistoryChanged(
  detail: ConversationDetailReport,
  historyPages: ConversationEventPage[],
): boolean {
  return historyPages.some(
    (page) => page.eventHistory.status !== detail.eventHistory.status,
  );
}

function orderedEvents(
  events: ConversationReportEvent[],
): ConversationReportEvent[] {
  return [...new Map(events.map((event) => [event.seq, event])).values()].sort(
    (left, right) => left.seq - right.seq,
  );
}

function withoutModelUsage(
  detail: ConversationDetailReport,
): ConversationDetailReport {
  const { modelUsage: _modelUsage, ...restricted } = detail;
  return restricted;
}
