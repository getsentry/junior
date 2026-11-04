/**
 * Open a long Conversation away from its latest events: at the reader's read
 * position, or at a linked event, Turn, or memory.
 *
 * The detail holds the latest page of events. When the read position is
 * older than that page, the transcript starts with the page around the read
 * position instead: the last read events and the unread events after them.
 * The first detail fetch of a visit brings that page, so it needs no second
 * request. A link to a row that the transcript does not hold starts it with
 * the page around that row, which the server finds in one request.
 * Like earlier pages, newer pages load when the reader scrolls near them, so
 * the server reads only the pages that the reader reaches.
 *
 * The latest page joins the transcript only after the newer pages reach it,
 * so the transcript never has a gap. Until then the transcript ends with a
 * row that loads the next newer page. A reader who jumps to the latest skips
 * the newer pages: the transcript shows the latest page from the detail at
 * once, and earlier pages load above it as the reader scrolls up. When a
 * poll skips past the newer pages after they join the latest page, or past a
 * newer page that has nothing after it, the transcript shows the latest page
 * in the same way, so it never drops the skipped events.
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
    /** Load the next newer page, or retry a failed one. */
    load: () => void;
    loading: boolean;
    /** Skip the newer pages and show the latest page. */
    showLatest: () => void;
  };
};

/**
 * The row that the transcript opens at: the `unreadCursor` of the read
 * position, or a linked event seq or Turn id.
 */
export type HistoryStart =
  | { around: string }
  | { event: string }
  | { turn: string };

/**
 * Load the transcript from the page around `start`. Returns `undefined` when
 * there is no start, or when the first page fails, so the caller shows the
 * latest page instead.
 */
export function useHistoryAround(input: {
  conversationId: string;
  /** The latest page, from the polled detail. */
  detail: ConversationDetailReport | undefined;
  start?: HistoryStart;
  /** Skip the newer pages. The caller then passes no `start`. */
  onShowLatest: () => void;
  /** The page around `start` failed. */
  onStartFailed?: () => void;
  /** The page around `start`, when the detail brought it. */
  startPage?: ConversationEventPage;
}): (TranscriptHistory & { isPending: boolean }) | undefined {
  const { conversationId, detail, onShowLatest, onStartFailed, start } = input;
  const startKey = start ? Object.entries(start)[0]?.join(":") : undefined;
  const latestEventsRef = useRef<ConversationReportEvent[]>([]);
  const latestEvents = useMemo(() => {
    const kept = keepLatestEvents(latestEventsRef.current, detail?.events);
    latestEventsRef.current = kept;
    return kept;
  }, [detail?.events]);
  const latestFirstSeq = latestEvents[0]?.seq;
  // The start whose newer pages joined the latest page.
  const joinedRef = useRef<string>(undefined);
  const newer = useInfiniteQuery({
    // Only the page around the start loads by itself. The data never goes
    // stale, so a refetch cannot reload every newer page at once.
    enabled: Boolean(start),
    staleTime: Infinity,
    // Each visit starts again from the page around the start. Pages from an
    // earlier visit can end at an old latest event, which would leave a gap
    // before the latest page.
    gcTime: 0,
    queryKey: ["conversation", conversationId, "around", startKey, "newer"],
    queryFn: ({ pageParam, signal }) =>
      readConversationEventsFrom(conversationId, pageParam, signal),
    initialPageParam: (start ?? { around: "" }) as NewerPageParam,
    // The page that came with the detail. Without it, the query reads it.
    ...(input.startPage && start
      ? { initialData: { pageParams: [start], pages: [input.startPage] } }
      : undefined),
    getNextPageParam: (page): NewerPageParam | undefined =>
      reachesLatest(page, latestFirstSeq) || !page.nextCursor
        ? undefined
        : { after: page.nextCursor },
    retry: false,
  });
  const firstNewerPage = newer.data?.pages[0];
  const earlier = useInfiniteQuery({
    enabled: false,
    queryKey: ["conversation", conversationId, "around", startKey, "earlier"],
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
  if (reached) joinedRef.current = startKey;
  // No newer page can fill the gap before the latest page, or the latest
  // events already on screen would leave until one does.
  const skipped =
    lastNewerPage !== undefined &&
    !reached &&
    (joinedRef.current === startKey || !lastNewerPage.nextCursor);
  useEffect(() => {
    if (skipped) onShowLatest();
  }, [onShowLatest, skipped]);
  const startFailed = Boolean(start && newer.error && !newerPages);
  useEffect(() => {
    if (startFailed) onStartFailed?.();
  }, [onStartFailed, startFailed]);
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

  if (!start || skipped || startFailed) {
    return undefined;
  }

  const hasPreviousPage = earlier.data
    ? earlier.hasNextPage
    : Boolean(firstNewerPage?.previousCursor);
  // `cancelRefetch: false` lets a second call join the page read in flight.
  // By default it cancels that read and starts the same read again.
  return {
    data,
    hasPreviousPage,
    historyError: earlier.error,
    historyVersion: conversationHistoryVersion(pages),
    isLoadingPreviousPage: earlier.isFetchingNextPage,
    isPending: !newerPages,
    loadPreviousPage: () => {
      if (hasPreviousPage) void earlier.fetchNextPage({ cancelRefetch: false });
    },
    ...(reached
      ? undefined
      : {
          newer: {
            error: newer.error,
            load: () => {
              if (newer.hasNextPage) {
                void newer.fetchNextPage({ cancelRefetch: false });
              }
            },
            loading: newer.isFetchingNextPage,
            showLatest: onShowLatest,
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
 * The newer pages reach the latest page when the latest page starts right
 * after them. Without latest events, they reach it when nothing follows them.
 */
function reachesLatest(
  page: ConversationEventPage,
  latestFirstSeq: number | undefined,
): boolean {
  const lastSeq = page.events.at(-1)?.seq;
  if (lastSeq === undefined || latestFirstSeq === undefined) {
    return !page.nextCursor;
  }
  return lastSeq + 1 >= latestFirstSeq;
}

/** The first page is around the start. The rest follow it. */
type NewerPageParam = HistoryStart | { after: string };

/** Read one bounded page of events around a start or after a cursor. */
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
