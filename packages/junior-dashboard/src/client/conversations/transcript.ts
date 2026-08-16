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

  if (historyPages.length === 0) return detail;

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
 * Reuse an unchanged event array without holding back fresh detail metadata.
 * Reporting events are immutable by sequence, so sequence and timestamp form a
 * cheap poll version. This avoids a deep walk through every event payload.
 */
export function reuseConversationEventReferences(
  previous: ConversationDetailReport | undefined,
  next: ConversationDetailReport,
): ConversationDetailReport {
  if (!previous || previous.events === next.events) return next;
  if (!sameConversationEventVersion(previous.events, next.events)) return next;
  return { ...next, events: previous.events };
}

function sameConversationEventVersion(
  previous: ConversationReportEvent[],
  next: ConversationReportEvent[],
): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index]!;
    const right = next[index]!;
    if (left.seq !== right.seq || left.createdAt !== right.createdAt) return false;
  }
  return true;
}
