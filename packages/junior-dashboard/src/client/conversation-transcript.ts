import type {
  ConversationDetailReport,
  ConversationEventPage,
  ConversationReportEvent,
  ConversationUpdatesReport,
} from "@sentry/junior/api/schema";

/** Build the current transcript from independently cached REST resources. */
export function buildConversationTranscript(
  detail: ConversationDetailReport,
  historyPages: ConversationEventPage[],
  updatePages: ConversationUpdatesReport[],
): ConversationDetailReport {
  const changedHistory = [...historyPages, ...updatePages].find(
    (page) => page.eventHistory.status !== detail.eventHistory.status,
  );

  if (changedHistory) {
    return withoutModelUsage({
      ...detail,
      eventHistory: changedHistory.eventHistory,
      events: changedHistory.events,
      previousCursor:
        "previousCursor" in changedHistory
          ? changedHistory.previousCursor
          : undefined,
    });
  }

  const latestUpdate = updatePages.at(-1);
  const current = latestUpdate
    ? conversationDetailFromUpdate(detail, latestUpdate)
    : detail;
  const lastHistoryPage = historyPages.at(-1);
  return {
    ...current,
    events: orderedEvents([
      ...historyPages.flatMap((page) => page.events),
      ...detail.events,
      ...updatePages.flatMap((page) => page.events),
    ]),
    previousCursor: lastHistoryPage
      ? lastHistoryPage.previousCursor
      : detail.previousCursor,
  };
}

/** Report whether a paged resource observed a different visibility state. */
export function conversationHistoryChanged(
  detail: ConversationDetailReport,
  historyPages: ConversationEventPage[],
  updatePages: ConversationUpdatesReport[],
): boolean {
  return [...historyPages, ...updatePages].some(
    (page) => page.eventHistory.status !== detail.eventHistory.status,
  );
}

function conversationDetailFromUpdate(
  detail: ConversationDetailReport,
  update: ConversationUpdatesReport,
): ConversationDetailReport {
  const { hasMore: _hasMore, ...current } = update;
  return {
    ...current,
    ...(update.modelUsage === undefined && detail.modelUsage
      ? { modelUsage: detail.modelUsage }
      : {}),
    previousCursor: detail.previousCursor,
    sentryConversationUrl: detail.sentryConversationUrl,
  };
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
