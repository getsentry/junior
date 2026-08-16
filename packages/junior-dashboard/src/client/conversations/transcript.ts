import type {
  ConversationDetailReport,
  ConversationEventPage,
  ConversationReportEvent,
} from "@sentry/junior/api/schema";

export type ConversationHistoryPage = ConversationEventPage & {
  requestedBefore: string;
};

/** Build the current transcript from independently cached REST resources. */
export function buildConversationTranscript(
  detail: ConversationDetailReport,
  historyPages: ConversationHistoryPage[],
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

  return {
    ...detail,
    events: orderedEvents([
      ...historyPages.flatMap((page) => page.events),
      ...detail.events,
    ]),
    previousCursor:
      conversationHistoryBridgeCursor(detail.previousCursor, historyPages) ??
      (historyPages.length
        ? oldestPreviousCursor(historyPages)
        : detail.previousCursor),
  };
}

/** Materialize one immutable detail snapshot through its exact history cursor chain. */
export async function loadCompleteConversationTranscript(args: {
  detail: ConversationDetailReport;
  historyPages: ConversationHistoryPage[];
  readPage: (before: string) => Promise<ConversationEventPage>;
}): Promise<ConversationDetailReport> {
  const cachedPages = new Map(
    args.historyPages.map((page) => [page.requestedBefore, page]),
  );
  const pages: ConversationHistoryPage[] = [];
  const seenCursors = new Set<string>();
  let before = args.detail.previousCursor;

  while (before) {
    if (seenCursors.has(before)) {
      throw new Error("Conversation history cursor did not advance");
    }
    seenCursors.add(before);

    const page =
      cachedPages.get(before) ??
      ({
        ...(await args.readPage(before)),
        requestedBefore: before,
      } satisfies ConversationHistoryPage);
    pages.push(page);
    before = page.previousCursor;
  }

  return buildConversationTranscript(args.detail, pages);
}

/** Identify the oldest event owned by the loaded history resource. */
export function conversationHistoryVersion(
  pages: ConversationEventPage[],
): string {
  const firstSeq = firstEventSeq(pages);
  return firstSeq === undefined ? "empty" : String(firstSeq);
}

/**
 * Return the next cursor needed to keep loaded history connected to detail.
 *
 * Pages remain reusable when detail polling slides the latest event window.
 * A new anchor page is fetched first, followed by bridge pages only until its
 * sequence range overlaps the history already in the query.
 */
export function nextConversationHistoryCursor(
  detailCursor: string | undefined,
  pages: ConversationHistoryPage[],
): string | undefined {
  return (
    conversationHistoryBridgeCursor(detailCursor, pages) ??
    oldestPreviousCursor(pages)
  );
}

/** Return a missing cursor only when a changed detail anchor needs a bridge. */
export function conversationHistoryBridgeCursor(
  detailCursor: string | undefined,
  pages: ConversationHistoryPage[],
): string | undefined {
  if (!detailCursor) return undefined;

  const pagesByCursor = new Map(
    pages.map((page) => [page.requestedBefore, page]),
  );
  const chain = new Set<ConversationHistoryPage>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined = detailCursor;

  while (cursor) {
    if (seenCursors.has(cursor)) return undefined;
    seenCursors.add(cursor);

    const page = pagesByCursor.get(cursor);
    if (!page) {
      return chain.size > 0 && chain.size === pages.length ? undefined : cursor;
    }
    chain.add(page);

    const chainStart = firstEventSeq(chain);
    const existingEnd = lastEventSeq(
      pages.filter((candidate) => !chain.has(candidate)),
    );
    if (
      chainStart !== undefined &&
      existingEnd !== undefined &&
      chainStart <= existingEnd + 1
    ) {
      return undefined;
    }

    cursor = page.previousCursor;
  }

  return undefined;
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

function firstEventSeq(
  pages: Iterable<ConversationEventPage>,
): number | undefined {
  let first: number | undefined;
  for (const page of pages) {
    const seq = page.events[0]?.seq;
    if (seq !== undefined && (first === undefined || seq < first)) first = seq;
  }
  return first;
}

function lastEventSeq(
  pages: Iterable<ConversationEventPage>,
): number | undefined {
  let last: number | undefined;
  for (const page of pages) {
    const seq = page.events.at(-1)?.seq;
    if (seq !== undefined && (last === undefined || seq > last)) last = seq;
  }
  return last;
}

function oldestPreviousCursor(
  pages: ConversationEventPage[],
): string | undefined {
  let oldest: ConversationEventPage | undefined;
  for (const page of pages) {
    const seq = page.events[0]?.seq;
    const oldestSeq = oldest?.events[0]?.seq;
    if (seq !== undefined && (oldestSeq === undefined || seq < oldestSeq)) {
      oldest = page;
    }
  }
  return oldest?.previousCursor;
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

/**
 * Keep the previous detail object when a live poll only refreshes metadata.
 * Poll responses always mint a new `generatedAt`, and that alone must not force
 * the dashboard to rebuild the transcript tree while the reader is typing.
 */
export function reuseUnchangedConversationDetail(
  previous: ConversationDetailReport | undefined,
  next: ConversationDetailReport,
): ConversationDetailReport {
  if (!previous) return next;
  if (previous === next) return previous;
  if (!sameConversationDetailContent(previous, next)) return next;
  return previous;
}

function sameConversationDetailContent(
  previous: ConversationDetailReport,
  next: ConversationDetailReport,
): boolean {
  // Ignore poll-only metadata: generatedAt, lastSeenAt, lastProgressAt, and
  // cumulativeDurationMs refresh while the event body is unchanged.
  return (
    previous.conversationId === next.conversationId &&
    previous.status === next.status &&
    previous.displayTitle === next.displayTitle &&
    previous.visibility === next.visibility &&
    previous.isParticipant === next.isParticipant &&
    previous.surface === next.surface &&
    previous.channel === next.channel &&
    previous.channelName === next.channelName &&
    previous.startedAt === next.startedAt &&
    previous.archivedAt === next.archivedAt &&
    previous.previousCursor === next.previousCursor &&
    previous.sentryConversationUrl === next.sentryConversationUrl &&
    sameJsonValue(previous.eventHistory, next.eventHistory) &&
    sameJsonValue(previous.actorIdentity, next.actorIdentity) &&
    sameJsonValue(previous.annotations, next.annotations) &&
    sameJsonValue(previous.modelUsage, next.modelUsage) &&
    sameJsonValue(previous.auxiliaryCosts, next.auxiliaryCosts) &&
    sameJsonValue(previous.sourceTask, next.sourceTask) &&
    sameConversationEvents(previous.events, next.events)
  );
}

function sameConversationEvents(
  previous: ConversationReportEvent[],
  next: ConversationReportEvent[],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index]!;
    const right = next[index]!;
    if (left === right) continue;
    if (left.seq !== right.seq || left.createdAt !== right.createdAt) {
      return false;
    }
    if (!sameJsonValue(left.data, right.data)) return false;
  }
  return true;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left == null || right == null) return left === right;
  if (typeof left !== typeof right) return false;
  if (typeof left !== "object") return left === right;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameJsonValue(left[index], right[index])) return false;
    }
    return true;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
    if (!sameJsonValue(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}
