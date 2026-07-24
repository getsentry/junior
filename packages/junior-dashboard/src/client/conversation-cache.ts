import type {
  ConversationDetailReport,
  ConversationEventPage,
  ConversationUpdatesReport,
} from "@sentry/junior/api/schema";

/** Append one forward update while preserving detail-only fields. */
export function mergeConversationUpdate(
  current: ConversationDetailReport,
  update: ConversationUpdatesReport,
): ConversationDetailReport {
  const existingSeqs = new Set(current.events.map((event) => event.seq));
  return {
    ...current,
    ...update,
    events: [
      ...current.events,
      ...update.events.filter((event) => !existingSeqs.has(event.seq)),
    ],
    modelUsage: current.modelUsage,
    previousCursor: current.previousCursor,
    sentryConversationUrl: current.sentryConversationUrl,
  };
}

/** Prepend one backward event page without replacing the live detail cursor. */
export function mergeConversationEventPage(
  current: ConversationDetailReport,
  page: ConversationEventPage,
): ConversationDetailReport {
  const existingSeqs = new Set(current.events.map((event) => event.seq));
  return {
    ...current,
    events: [
      ...page.events.filter((event) => !existingSeqs.has(event.seq)),
      ...current.events,
    ],
    eventHistory: page.eventHistory,
    previousCursor: page.previousCursor,
  };
}
