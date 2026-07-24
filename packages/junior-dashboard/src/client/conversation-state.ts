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
  const { hasMore: _hasMore, ...detailUpdate } = update;
  const {
    actorIdentity: _actorIdentity,
    archivedAt: _archivedAt,
    channel: _channel,
    channelName: _channelName,
    channelNameRedacted: _channelNameRedacted,
    cumulativeUsage: _cumulativeUsage,
    locationId: _locationId,
    sentryTraceUrl: _sentryTraceUrl,
    traceId: _traceId,
    ...detailBase
  } = current;
  const existingSeqs = new Set(current.events.map((event) => event.seq));
  return {
    ...detailBase,
    ...detailUpdate,
    events: [
      ...current.events,
      ...update.events.filter((event) => !existingSeqs.has(event.seq)),
    ],
    modelUsage: update.modelUsage ?? current.modelUsage,
    previousCursor: current.previousCursor,
    sentryConversationUrl: current.sentryConversationUrl,
  };
}

/** Prepend one backward event page without replacing the live detail cursor. */
export function mergeConversationEventPage(
  current: ConversationDetailReport,
  page: ConversationEventPage,
): ConversationDetailReport {
  const events = new Map(
    [...page.events, ...current.events].map((event) => [event.seq, event]),
  );
  return {
    ...current,
    events: [...events.values()].sort((left, right) => left.seq - right.seq),
    eventHistory: page.eventHistory,
    previousCursor: page.previousCursor,
  };
}

/** Add a fully drained history without replacing newer live detail fields. */
export function mergeCompleteConversationHistory(
  current: ConversationDetailReport,
  complete: ConversationDetailReport,
): ConversationDetailReport {
  if (complete.eventHistory.status !== current.eventHistory.status) {
    return current.eventHistory.status === "available" ? complete : current;
  }
  const events = new Map(
    [...complete.events, ...current.events].map((event) => [event.seq, event]),
  );
  return {
    ...current,
    events: [...events.values()].sort((left, right) => left.seq - right.seq),
    previousCursor: complete.previousCursor,
  };
}

/** Refresh detail fields without discarding history pages already in the cache. */
export function mergeConversationSnapshot(
  current: ConversationDetailReport,
  snapshot: ConversationDetailReport,
): ConversationDetailReport {
  if (snapshot.eventHistory.status !== current.eventHistory.status) {
    return snapshot;
  }
  const events = new Map(
    [...current.events, ...snapshot.events].map((event) => [event.seq, event]),
  );
  return {
    ...snapshot,
    events: [...events.values()].sort((left, right) => left.seq - right.seq),
    previousCursor: current.previousCursor,
  };
}
