/**
 * Open a long Conversation away from its latest events: at the reader's read
 * position, or at a linked event, Turn, or memory.
 *
 * The detail holds the latest page of events. When the read position is
 * older than that page, the transcript starts with the events around the
 * read position instead: the last read events and the unread events after
 * them. The first detail fetch of a visit brings that page, so it needs no
 * second request. A link to a row that the transcript does not hold starts
 * it with the events around that row, which the server finds in one
 * request. Like earlier pages, newer pages load when the reader scrolls near
 * them, so the server reads only the pages that the reader reaches.
 *
 * Every read joins the runs of the Conversation (`transcriptEventRuns`), and
 * the transcript shows the run that holds the start. A start that a run
 * holds shows at once, and a read brings only the events that no run holds.
 *
 * The latest page joins the transcript only after the run reaches it, so the
 * transcript never has a gap. Until then the transcript ends with a row that
 * loads the next newer page. A reader who jumps to the latest skips the
 * newer pages: the transcript shows the latest page from the detail at once,
 * and earlier pages load above it as the reader scrolls up. When a poll
 * skips past the run after it joins the latest page, the transcript shows
 * the latest page in the same way, so it never drops the skipped events.
 */
import { useEffect, useMemo, useRef } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  conversationEventPageSchema,
  type ConversationDetailReport,
  type ConversationEventPage,
  type ConversationReportEvent,
} from "@sentry/junior/api/schema";

import { fetchDashboardJson } from "../http";
import {
  buildUnreadConversationTranscript,
  conversationHistoryVersion,
} from "./transcript";
import {
  CONVERSATION_EVENT_PARAM,
  CONVERSATION_MESSAGE_PARAM,
  CONVERSATION_TURN_PARAM,
  messageEventSeq,
  parseConversationEventSeq,
  turnStartedEventSeq,
} from "./conversationRoutes";
import {
  AROUND_EVENTS,
  aroundReads,
  earlierRead,
  endRead,
  eventRunsKey,
  holdEventPage,
  joinEventPage,
  laterRead,
  readEventRuns,
  runAt,
  type EventRead,
  type EventRuns,
} from "./transcriptEventRuns";

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
 * position, or a linked event seq, Turn id, or Message id.
 */
export type HistoryStart =
  | { around: string }
  | { event: string }
  | { message: string }
  | { turn: string };

/**
 * Load the transcript from the events around `start`. Returns `undefined`
 * when there is no start, or when the first read fails, so the caller shows
 * the latest page instead.
 */
export function useHistoryAround(input: {
  conversationId: string;
  /** The latest page, from the polled detail. */
  detail: ConversationDetailReport | undefined;
  start?: HistoryStart;
  /** Skip the newer pages. The caller then passes no `start`. */
  onShowLatest: () => void;
  /** The read around `start` failed. */
  onStartFailed?: () => void;
  /** The page around `start`, when the detail brought it. */
  startPage?: ConversationEventPage;
}): (TranscriptHistory & { isPending: boolean }) | undefined {
  const { conversationId, detail, onShowLatest, onStartFailed, start } = input;
  const startKey = start ? historyStartKey(start) : undefined;
  const queryClient = useQueryClient();
  // The runs live as long as the Conversation's queries: while a page shows
  // it, and for the cache time after.
  const heldRuns = useQuery({
    initialData: NO_RUNS,
    queryFn: ({ client }) => readEventRuns(client, conversationId),
    queryKey: eventRunsKey(conversationId),
    staleTime: Infinity,
  }).data;
  // The page that came with the detail joins the runs before the first
  // render, so the transcript opens at once.
  const startPage = input.startPage;
  const runs = useMemo(
    () => (startPage ? joinEventPage(heldRuns, startPage) : heldRuns),
    [heldRuns, startPage],
  );
  useEffect(() => {
    if (startPage) holdEventPage(queryClient, conversationId, startPage);
  }, [conversationId, queryClient, startPage]);
  const latestEventsRef = useRef<ConversationReportEvent[]>([]);
  const latestEvents = useMemo(() => {
    const kept = keepLatestEvents(latestEventsRef.current, detail?.events);
    latestEventsRef.current = kept;
    return kept;
  }, [detail?.events]);
  const latestFirstSeq = latestEvents[0]?.seq;
  // A start that the runs hold shows at once. Its query then reads only the
  // events around it that the runs do not hold. The page from the detail
  // needs no read.
  const startPageSeq = startPage?.events[0]?.seq;
  const heldSeq = start === undefined ? undefined : heldStartSeq(runs, start);
  const around = useQuery({
    ...aroundQuery(conversationId, start ?? { around: "" }),
    enabled: Boolean(start),
    ...(startPageSeq !== undefined
      ? { initialData: { seq: startPageSeq } }
      : heldSeq !== undefined
        ? { initialData: { seq: heldSeq }, initialDataUpdatedAt: 0 }
        : undefined),
  });
  const aroundData = around.data;
  const shownSeq =
    aroundData && "seq" in aroundData ? aroundData.seq : undefined;
  // A run can leave the cache while it shows, when far reads pass the cap.
  const shownRunRef = useRef<{ key?: string; run?: ConversationEventPage }>({});
  const run =
    (shownSeq === undefined ? undefined : runAt(runs, shownSeq)) ??
    (aroundData && "page" in aroundData ? aroundData.page : undefined) ??
    (shownRunRef.current.key === startKey
      ? shownRunRef.current.run
      : undefined);
  shownRunRef.current = { key: startKey, run };
  // A cached row whose run left the cache reads its events again.
  const lost = Boolean(start && aroundData && !run && !around.isFetching);
  const refetchAround = around.refetch;
  useEffect(() => {
    if (lost) void refetchAround();
  }, [lost, refetchAround]);

  const readInto = (read: EventRead) =>
    readHeldPage(queryClient, conversationId, read);
  const earlier = useMutation({ mutationFn: readInto, retry: false });
  const newer = useMutation({ mutationFn: readInto, retry: false });

  // The start whose run joined the latest page.
  const joinedRef = useRef<string>(undefined);
  const reached = run ? reachesLatest(run, latestFirstSeq) : false;
  if (reached) joinedRef.current = startKey;
  // A poll skipped past the run after it joined the latest page, so the
  // latest events on screen would leave until one more page loads.
  const skipped =
    run !== undefined && !reached && joinedRef.current === startKey;
  useEffect(() => {
    if (skipped) onShowLatest();
  }, [onShowLatest, skipped]);
  const startFailed = Boolean(start && around.error && !run);
  useEffect(() => {
    if (startFailed) onStartFailed?.();
  }, [onStartFailed, startFailed]);
  const data = useMemo(
    () =>
      detail && run
        ? buildUnreadConversationTranscript(
            detail,
            [run],
            reached ? latestEvents : [],
          )
        : undefined,
    [detail, latestEvents, reached, run],
  );

  if (!start || skipped || startFailed) {
    return undefined;
  }

  const runIndex = run ? runs.indexOf(run) : -1;
  const loadNewer = () => {
    if (!run || newer.isPending) return;
    const next = runs[runIndex + 1]?.events[0]?.seq;
    const nextFirstSeq =
      next === undefined || latestFirstSeq === undefined
        ? (next ?? latestFirstSeq)
        : Math.min(next, latestFirstSeq);
    const [read] = run.nextCursor
      ? laterRead(run, nextFirstSeq)
      : [endRead(run)];
    if (read) newer.mutate(read);
  };
  return {
    data,
    hasPreviousPage: Boolean(run?.previousCursor),
    historyError: earlier.error,
    historyVersion: conversationHistoryVersion(run ? [run] : []),
    isLoadingPreviousPage: earlier.isPending,
    isPending: !run,
    loadPreviousPage: () => {
      if (!run || earlier.isPending) return;
      const [read] = earlierRead(run, runs[runIndex - 1]);
      if (read) earlier.mutate(read);
    },
    ...(reached
      ? undefined
      : {
          newer: {
            error: newer.error,
            load: loadNewer,
            loading: newer.isPending,
            showLatest: onShowLatest,
          },
        }),
  };
}

const NO_RUNS: EventRuns = [];

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

/** How long the events around a start count as read. */
const AROUND_STALE_MS = 30_000;

/**
 * Read the events around a start before the reader picks it, for example
 * when an outline preview opens, so the jump to it needs no request.
 */
export function prefetchHistoryAround(
  queryClient: QueryClient,
  conversationId: string,
  start: HistoryStart,
): Promise<void> {
  return queryClient.prefetchQuery(aroundQuery(conversationId, start));
}

/** True when the runs of the Conversation hold the row of a start. */
export function holdsHistoryStart(
  queryClient: QueryClient,
  conversationId: string,
  start: HistoryStart,
): boolean {
  return (
    heldStartSeq(readEventRuns(queryClient, conversationId), start) !==
    undefined
  );
}

/** The seq of the row of a start, when the runs hold it. */
function heldStartSeq(
  runs: EventRuns,
  start: HistoryStart,
): number | undefined {
  const events = runs.flatMap((run) => run.events);
  const seq =
    "event" in start
      ? Number(start.event)
      : "message" in start
        ? messageEventSeq(events, start.message)
        : "turn" in start
          ? turnStartedEventSeq(events, start.turn)
          : undefined;
  return seq !== undefined && runAt(runs, seq) ? seq : undefined;
}

/**
 * The row that the transcript shows for a start, once the runs hold the
 * events around it. A Conversation with no events to show gives its page.
 */
type AroundRow = { seq: number } | { page: ConversationEventPage };

/**
 * Read the events around a start into the runs. A start that the runs hold
 * reads only what they miss around it.
 */
function aroundQuery(conversationId: string, start: HistoryStart) {
  return queryOptions({
    gcTime: AROUND_STALE_MS,
    queryFn: async ({ client }): Promise<AroundRow> => {
      const runs = readEventRuns(client, conversationId);
      // An event start reads only the events it lacks, even when the
      // runs do not hold it yet.
      const seq =
        heldStartSeq(runs, start) ??
        ("event" in start ? Number(start.event) : undefined);
      if (seq === undefined) {
        const page = await readHeldPage(client, conversationId, {
          query: { ...start, limit: String(AROUND_EVENTS) },
        });
        const found =
          "message" in start
            ? messageEventSeq(page.events, start.message)
            : "turn" in start
              ? turnStartedEventSeq(page.events, start.turn)
              : undefined;
        const shown = found ?? page.events[0]?.seq;
        return shown === undefined ? { page } : { seq: shown };
      }
      // At most two reads: one on each side of the row.
      const readSides = async (held: EventRuns) => {
        const [first, second] = aroundReads(held, seq);
        await Promise.all([
          first && readHeldPage(client, conversationId, first),
          second && readHeldPage(client, conversationId, second),
        ]);
      };
      await readSides(runs);
      // A read that joined another read of its cursor can stop short of
      // the row. Then the row reads on from there.
      const held = readEventRuns(client, conversationId);
      if (!runAt(held, seq)) await readSides(held);
      return { seq };
    },
    queryKey: [
      "conversation",
      conversationId,
      "around",
      historyStartKey(start),
      "row",
    ],
    retry: false,
    staleTime: AROUND_STALE_MS,
  });
}

function historyStartKey(start: HistoryStart): string | undefined {
  return Object.entries(start)[0]?.join(":");
}

/**
 * Read a page into the runs. A read from the cursor of a read in flight
 * joins it, so two reads that start at the same run end read no event twice.
 */
function readHeldPage(
  queryClient: QueryClient,
  conversationId: string,
  read: EventRead,
): Promise<ConversationEventPage> {
  const { after, before } = read.query;
  // The cursor keys the read, so reads from one cursor join.
  // oxlint-disable-next-line @tanstack/query/exhaustive-deps
  return queryClient.fetchQuery({
    gcTime: 0,
    queryFn: ({ signal }) =>
      readEventPage(conversationId, read.query, signal).then((page) => {
        holdEventPage(queryClient, conversationId, page, read);
        return page;
      }),
    queryKey: [
      "conversation",
      conversationId,
      "event-read",
      after
        ? `after:${after}`
        : before
          ? `before:${before}`
          : new URLSearchParams(read.query).toString(),
    ],
    staleTime: 0,
  });
}

/** Read one bounded page of events before, after, or around a boundary. */
function readEventPage(
  conversationId: string,
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<ConversationEventPage> {
  return fetchDashboardJson(
    conversationEventPageSchema,
    `/api/conversations/${encodeURIComponent(conversationId)}/events?${new URLSearchParams(query)}`,
    signal,
  ).then((page) => {
    const { after, before } = query;
    if (
      (after && page.nextCursor === after) ||
      (before && page.previousCursor === before)
    ) {
      throw new Error("Conversation history cursor did not advance");
    }
    return page;
  });
}

/** A linked event seq, Turn id, or Message id. */
export type ConversationLink =
  | { event: number }
  | { message: string }
  | { turn: string };

/** Read the link of a page URL. A Turn wins over an event, then a Message. */
export function readConversationLink(
  params: URLSearchParams,
): ConversationLink | undefined {
  const turn = params.get(CONVERSATION_TURN_PARAM);
  if (turn) return { turn };
  const event = parseConversationEventSeq(params.get(CONVERSATION_EVENT_PARAM));
  if (event !== undefined) return { event };
  const message = params.get(CONVERSATION_MESSAGE_PARAM);
  return message ? { message } : undefined;
}

/** The page to open for a link, or nothing when `events` hold its row. */
export function unheldLinkStart(
  events: readonly ConversationReportEvent[] | undefined,
  link: ConversationLink,
): HistoryStart | undefined {
  const seq =
    "event" in link
      ? link.event
      : "message" in link
        ? messageEventSeq(events, link.message)
        : turnStartedEventSeq(events, link.turn);
  const held =
    seq !== undefined &&
    events !== undefined &&
    seq >= (events[0]?.seq ?? Infinity) &&
    seq <= (events.at(-1)?.seq ?? -Infinity);
  if (held) return undefined;
  return "event" in link ? { event: String(link.event) } : link;
}
