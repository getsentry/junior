/**
 * Open a long Conversation at the reader's read position.
 *
 * The detail holds the latest page of events. When the read position is
 * older than that page, the transcript starts with the page around the read
 * position instead: the last read events and the unread events after them.
 * Newer pages then load one at a time in the background, until they reach
 * the latest page. Earlier pages load on scroll, from the read position back
 * toward the start.
 *
 * The latest page joins the transcript only after the newer pages reach it,
 * so the transcript never has a gap. Until then the transcript ends with a
 * row that shows the newer pages load.
 */
import { useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  conversationEventPageSchema,
  type ConversationDetailReport,
  type ConversationEventPage,
  type ConversationReportEvent,
} from "@sentry/junior/api/schema";

import { fetchDashboardJson } from "../http";
import { readConversationEvents } from "./queries";
import {
  buildUnreadConversationTranscript,
  conversationHistoryVersion,
} from "./transcript";

/** The transcript to show and how to load more of it. */
export type TranscriptHistory = {
  data: ConversationDetailReport | undefined;
  hasPreviousPage: boolean;
  historyError: Error | null;
  historyVersion: string;
  isLoadingPreviousPage: boolean;
  loadPreviousPage: () => void;
  /** Set while newer pages have not reached the latest page. */
  newer?: {
    error: Error | null;
    /** Retry a failed page. */
    load: () => void;
  };
};

/**
 * Load the transcript from `unreadCursor`. Returns `undefined` when there is
 * no cursor, or when the first page fails, so the caller shows the latest
 * page instead.
 */
export function useUnreadHistory(input: {
  conversationId: string;
  /** The latest page, from the polled detail. */
  detail: ConversationDetailReport | undefined;
  /** `unreadCursor` from the detail when the Conversation opened. */
  unreadCursor: string | undefined;
}): (TranscriptHistory & { isPending: boolean }) | undefined {
  const { conversationId, detail, unreadCursor } = input;
  const latestEventsRef = useRef<ConversationReportEvent[]>([]);
  const latestEvents = useMemo(() => {
    const kept = keepLatestEvents(latestEventsRef.current, detail?.events);
    latestEventsRef.current = kept;
    return kept;
  }, [detail?.events]);
  const latestFirstSeq = latestEvents[0]?.seq;
  const newer = useInfiniteQuery({
    enabled: false,
    queryKey: ["conversation", conversationId, "unread", unreadCursor, "newer"],
    queryFn: ({ pageParam, signal }) =>
      readConversationEventsFrom(conversationId, pageParam, signal),
    initialPageParam: { around: unreadCursor ?? "" } as NewerPageParam,
    getNextPageParam: (page): NewerPageParam | undefined =>
      reachesLatest(page, latestFirstSeq) || !page.nextCursor
        ? undefined
        : { after: page.nextCursor },
    retry: false,
  });
  const firstNewerPage = newer.data?.pages[0];
  const earlier = useInfiniteQuery({
    enabled: false,
    queryKey: [
      "conversation",
      conversationId,
      "unread",
      unreadCursor,
      "earlier",
    ],
    queryFn: ({ pageParam, signal }) =>
      readConversationEvents(conversationId, pageParam, signal),
    initialPageParam: firstNewerPage?.previousCursor ?? "",
    getNextPageParam: (page) => page.previousCursor,
    retry: false,
  });

  const newerPages = newer.data?.pages;
  const earlierPages = earlier.data?.pages;
  const lastNewerPage = newerPages?.at(-1);
  const reached = lastNewerPage
    ? reachesLatest(lastNewerPage, latestFirstSeq)
    : false;
  const pages = useMemo(
    () => [...(earlierPages ?? []), ...(newerPages ?? [])],
    [earlierPages, newerPages],
  );
  const data = useMemo(
    () =>
      detail && newerPages
        ? buildUnreadConversationTranscript(
            detail,
            pages,
            reached ? latestEvents : [],
          )
        : undefined,
    [detail, latestEvents, newerPages, pages, reached],
  );

  // Load newer pages one at a time until they reach the latest page. A
  // failed page stops the loop; the reader can retry it.
  const fetchNewerPage = newer.fetchNextPage;
  const loadNewer =
    Boolean(unreadCursor) &&
    !newer.isFetching &&
    !newer.error &&
    (!newerPages || newer.hasNextPage);
  useEffect(() => {
    if (loadNewer) void fetchNewerPage();
  }, [fetchNewerPage, loadNewer, newerPages?.length]);

  if (!unreadCursor || (newer.error && !newerPages)) return undefined;

  const hasPreviousPage = earlier.data
    ? earlier.hasNextPage
    : Boolean(firstNewerPage?.previousCursor);
  return {
    data,
    hasPreviousPage,
    historyError: earlier.error,
    historyVersion: conversationHistoryVersion(pages),
    isLoadingPreviousPage: earlier.isFetchingNextPage,
    isPending: !newerPages,
    loadPreviousPage: () => {
      if (hasPreviousPage && !earlier.isFetchingNextPage) {
        void earlier.fetchNextPage();
      }
    },
    ...(reached
      ? undefined
      : {
          newer: {
            error: newer.error,
            load: () => {
              if (!newer.isFetching) void newer.fetchNextPage();
            },
          },
        }),
  };
}

/**
 * Keep the events that new events push out of the latest page. Without them,
 * the latest page would start after the newer pages again, and the transcript
 * would drop its latest events until one more page loads. A poll that skips
 * past the kept events starts over from its own events.
 */
function keepLatestEvents(
  kept: ConversationReportEvent[],
  events: ConversationReportEvent[] | undefined,
): ConversationReportEvent[] {
  const firstSeq = events?.[0]?.seq;
  const keptLastSeq = kept.at(-1)?.seq;
  if (!events || firstSeq === undefined) return kept;
  if (keptLastSeq === undefined || firstSeq > keptLastSeq + 1) return events;
  const slid = kept.filter((event) => event.seq < firstSeq);
  return slid.length ? [...slid, ...events] : events;
}

/**
 * The newer pages reach the latest page when nothing follows them, or when
 * the latest page starts right after them.
 */
function reachesLatest(
  page: ConversationEventPage,
  latestFirstSeq: number | undefined,
): boolean {
  if (!page.nextCursor) return true;
  const lastSeq = page.events.at(-1)?.seq;
  return (
    lastSeq !== undefined &&
    latestFirstSeq !== undefined &&
    lastSeq + 1 >= latestFirstSeq
  );
}

/** The first page is around the read position. The rest follow it. */
type NewerPageParam = { around: string } | { after: string };

/** Read one bounded page of events around or after a history cursor. */
function readConversationEventsFrom(
  conversationId: string,
  param: NewerPageParam,
  signal?: AbortSignal,
): Promise<ConversationEventPage> {
  const query = new URLSearchParams(param);
  return fetchDashboardJson(
    conversationEventPageSchema,
    `/api/conversations/${encodeURIComponent(conversationId)}/events?${query}`,
    signal,
  ).then((page) => {
    if ("after" in param && page.nextCursor === param.after) {
      throw new Error("Conversation history cursor did not advance");
    }
    return page;
  });
}
