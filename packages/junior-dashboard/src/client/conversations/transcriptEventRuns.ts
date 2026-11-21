/**
 * Hold the events that transcript reads bring for one Conversation, so the
 * client reads each event once and builds a fuller picture of the
 * Conversation as the reader moves through it.
 *
 * The events sit in runs: pages with no gap inside, sorted by seq and apart
 * from each other. A read that overlaps or touches a run, or continues it
 * from its cursor, joins it. A jump reads only the events around its target
 * that no run holds: it continues a near run from its cursor, and it stops
 * at the next run, so it reads no held event.
 */
import type { QueryClient } from "@tanstack/react-query";
import type {
  ConversationEventPage,
  ConversationReportEvent,
} from "@sentry/junior/api/schema";

/** Runs of one Conversation, sorted by seq. */
export type EventRuns = readonly ConversationEventPage[];

/**
 * Events that a jump shows around its target: twice the server's default
 * page, half on each side, so a short scroll from the target needs no read.
 */
export const AROUND_EVENTS = 300;
const SIDE_EVENTS = AROUND_EVENTS / 2;

/** The server's default page, `CONVERSATION_EVENT_PAGE_LIMIT`. */
const PAGE_EVENTS = 150;

/**
 * Events the runs hold at most, about 3 MB. Past it, the runs farthest from
 * the latest read go.
 */
const MAX_HELD_EVENTS = 5_000;

/** One page read, and the runs it continues. */
export type EventRead = {
  /** Seq of the first event of the run that the read reaches. */
  before?: number;
  /** Seq of the last event of the run that the read continues. */
  after?: number;
  query: Record<string, string>;
};

/** Cache key of the runs of one Conversation. */
export function eventRunsKey(conversationId: string) {
  return ["conversation", conversationId, "event-runs"] as const;
}

/** The runs of one Conversation in the cache. */
export function readEventRuns(
  queryClient: QueryClient,
  conversationId: string,
): EventRuns {
  return queryClient.getQueryData(eventRunsKey(conversationId)) ?? [];
}

/** Join a page that `read` brought into the cached runs. */
export function holdEventPage(
  queryClient: QueryClient,
  conversationId: string,
  page: ConversationEventPage,
  read?: EventRead,
) {
  queryClient.setQueryData<EventRuns>(
    eventRunsKey(conversationId),
    (runs = []) => joinEventPage(runs, page, read),
  );
}

/** The run that holds `seq`. */
export function runAt(
  runs: EventRuns,
  seq: number,
): ConversationEventPage | undefined {
  return runs.find((run) => firstSeq(run) <= seq && seq <= lastSeq(run));
}

/**
 * Join a page into the runs. It merges with the runs it overlaps or
 * touches, and with the runs that `read` continues.
 */
export function joinEventPage(
  runs: EventRuns,
  page: ConversationEventPage,
  read?: EventRead,
): EventRuns {
  const first = page.events[0]?.seq;
  const last = page.events.at(-1)?.seq;
  if (first === undefined || last === undefined) return runs;
  const joins = (run: ConversationEventPage) =>
    (firstSeq(run) <= last + 1 && first <= lastSeq(run) + 1) ||
    lastSeq(run) === read?.after ||
    firstSeq(run) === read?.before;
  const joined = mergeRuns([...runs.filter(joins), page]);
  const kept = [...runs.filter((run) => !joins(run)), joined].sort(
    (a, b) => firstSeq(a) - firstSeq(b),
  );
  return evictFarthest(kept, joined);
}

/**
 * The reads that complete the events around `seq`. None when the runs hold
 * them, or when no cursor leads to more.
 */
export function aroundReads(runs: EventRuns, seq: number): EventRead[] {
  const index = runs.findIndex(
    (run) => firstSeq(run) <= seq && seq <= lastSeq(run),
  );
  const run = runs[index];
  if (run) {
    // A side that holds fewer events than the window reads one page, so
    // short reads do not add up to many requests.
    const at = run.events.findIndex((event) => event.seq >= seq);
    const after = run.events.length - 1 - at;
    return [
      ...(at < SIDE_EVENTS ? earlierRead(run, runs[index - 1]) : []),
      ...(after < SIDE_EVENTS
        ? laterRead(run, runs[index + 1]?.events[0]?.seq)
        : []),
    ];
  }
  const previous = runs.filter((held) => lastSeq(held) < seq).at(-1);
  const next = runs.find((held) => firstSeq(held) > seq);
  // A near run reads on from its cursor through the target, so the read
  // holds no event twice. A seq gap bounds the events in it.
  if (previous?.nextCursor && seq - lastSeq(previous) <= AROUND_EVENTS) {
    return laterRead(
      previous,
      next && firstSeq(next),
      seq - lastSeq(previous) + SIDE_EVENTS,
    );
  }
  if (next?.previousCursor && firstSeq(next) - seq <= AROUND_EVENTS) {
    return earlierRead(next, previous, firstSeq(next) - seq + SIDE_EVENTS);
  }
  return [{ query: { event: String(seq), limit: String(AROUND_EVENTS) } }];
}

/** Read the page before a run, up to the run before it. */
export function earlierRead(
  run: ConversationEventPage,
  previous: ConversationEventPage | undefined,
  want = PAGE_EVENTS,
): EventRead[] {
  if (!run.previousCursor) return [];
  const gap = previous ? firstSeq(run) - lastSeq(previous) - 1 : Infinity;
  const limit = Math.min(want, gap);
  return [
    {
      before: firstSeq(run),
      ...(previous && limit === gap ? { after: lastSeq(previous) } : undefined),
      query: { before: run.previousCursor, limit: String(limit) },
    },
  ];
}

/**
 * Read the page after a run, up to `nextFirstSeq`: the next run, or the
 * latest page. None when the run ended at the latest event when it was read.
 */
export function laterRead(
  run: ConversationEventPage,
  nextFirstSeq: number | undefined,
  want = PAGE_EVENTS,
): EventRead[] {
  const last = lastSeq(run);
  if (!run.nextCursor) return [];
  const gap = nextFirstSeq === undefined ? Infinity : nextFirstSeq - last - 1;
  const limit = Math.min(want, gap);
  if (limit <= 0) return [];
  return [
    {
      after: last,
      ...(nextFirstSeq !== undefined && limit === gap
        ? { before: nextFirstSeq }
        : undefined),
      query: { after: run.nextCursor, limit: String(limit) },
    },
  ];
}

/**
 * Read the last event of a run that ended at the latest event when it was
 * read, with the one after it, so the run gets a cursor when newer events
 * follow.
 */
export function endRead(run: ConversationEventPage): EventRead {
  const last = lastSeq(run);
  return { after: last, query: { event: String(last), limit: "2" } };
}

/**
 * Merge runs that join into one. Events from later runs win, so the page
 * read last gives the current copy of each event.
 */
function mergeRuns(runs: ConversationEventPage[]): ConversationEventPage {
  const events = new Map<number, ConversationReportEvent>();
  for (const run of runs) {
    for (const event of run.events) events.set(event.seq, event);
  }
  const earliest = runs.reduce((a, b) => (firstSeq(b) < firstSeq(a) ? b : a));
  const latest = runs.reduce((a, b) => (lastSeq(b) >= lastSeq(a) ? b : a));
  const newest = runs.at(-1)!;
  return {
    eventHistory: newest.eventHistory,
    events: [...events.values()].sort((a, b) => a.seq - b.seq),
    generatedAt: newest.generatedAt,
    ...(earliest.previousCursor
      ? { previousCursor: earliest.previousCursor }
      : undefined),
    ...(latest.nextCursor ? { nextCursor: latest.nextCursor } : undefined),
  };
}

function evictFarthest(
  runs: ConversationEventPage[],
  kept: ConversationEventPage,
): EventRuns {
  let held = runs.reduce((count, run) => count + run.events.length, 0);
  const middle = (run: ConversationEventPage) =>
    (firstSeq(run) + lastSeq(run)) / 2;
  const left = [...runs];
  while (held > MAX_HELD_EVENTS && left.length > 1) {
    const farthest = left
      .filter((run) => run !== kept)
      .reduce((a, b) =>
        Math.abs(middle(b) - middle(kept)) > Math.abs(middle(a) - middle(kept))
          ? b
          : a,
      );
    left.splice(left.indexOf(farthest), 1);
    held -= farthest.events.length;
  }
  return left;
}

function firstSeq(run: ConversationEventPage): number {
  return run.events[0]?.seq ?? Infinity;
}

function lastSeq(run: ConversationEventPage): number {
  return run.events.at(-1)?.seq ?? -Infinity;
}
