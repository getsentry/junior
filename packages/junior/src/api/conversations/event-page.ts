import { hydrateMessageAttachments } from "./message-attachments";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  lt,
  max,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ConversationEvent } from "@/chat/conversations/history";
import { eventFromRow } from "@/chat/conversations/sql/history";
import { startSpan } from "@/chat/sentry";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import type { ConversationReportEvent } from "../schema/conversation";
import {
  conversationReportToolResultIds,
  conversationReportSourceEventTypes,
  projectConversationReportEventPage,
} from "./events";

const conversationEventColumns = getTableColumns(juniorConversationEvents);
const MIN_SCAN_SIZE = 64;

/** Read bounded canonical rows while excluding model-only replacement history. */
async function readConversationEventRows(
  executor: JuniorSqlDatabase,
  args: {
    afterSeq?: number | SQL | undefined;
    beforeSeq?: number | undefined;
    conversationId: string;
    direction: "backward" | "forward";
    limit: number;
    subagentInvocationIds?: string[];
    toolCallIds?: string[];
    types?: ConversationEvent["data"]["type"][];
  },
) {
  return executor
    .db()
    .select({
      ...conversationEventColumns,
      // Replacement history is model context, never dashboard report data.
      payload: sql<Record<string, unknown>>`case
        when ${juniorConversationEvents.type} in ('compaction', 'handoff')
        then jsonb_set(
          ${juniorConversationEvents.payload},
          '{replacementHistory}',
          '[]'::jsonb
        )
        else ${juniorConversationEvents.payload}
      end`,
    })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, args.conversationId),
        args.beforeSeq === undefined
          ? undefined
          : lt(juniorConversationEvents.seq, args.beforeSeq),
        args.afterSeq === undefined
          ? undefined
          : gt(juniorConversationEvents.seq, args.afterSeq),
        inArray(
          juniorConversationEvents.type,
          args.types ?? [...conversationReportSourceEventTypes],
        ),
        args.subagentInvocationIds === undefined
          ? undefined
          : inArray(
              sql<string>`${juniorConversationEvents.payload}->>'subagentInvocationId'`,
              args.subagentInvocationIds,
            ),
        args.toolCallIds === undefined
          ? undefined
          : inArray(
              sql<string>`${juniorConversationEvents.payload}->>'toolCallId'`,
              args.toolCallIds,
            ),
      ),
    )
    .orderBy(
      args.direction === "forward"
        ? asc(juniorConversationEvents.seq)
        : desc(juniorConversationEvents.seq),
    )
    .limit(args.limit);
}

/**
 * Read the last Turn end before the `turns`-th latest Turn start. Its seq is
 * null when the Conversation has fewer Turns, or no Turn ended before them.
 *
 * Input messages are written before their `turn_started`, so a page of the
 * latest Turns starts after the Turn before them, not at the start event.
 */
function readLatestTurnsPageStart(
  executor: JuniorSqlDatabase,
  conversationId: string,
  turns: number,
) {
  const started = alias(juniorConversationEvents, "started");
  const ended = alias(juniorConversationEvents, "ended");
  const turnStart = executor
    .db()
    .select({ seq: started.seq })
    .from(started)
    .where(
      and(
        eq(started.conversationId, conversationId),
        eq(started.type, "turn_started"),
      ),
    )
    .orderBy(desc(started.seq))
    .offset(turns - 1)
    .limit(1);
  return executor
    .db()
    .select({ seq: max(ended.seq) })
    .from(ended)
    .where(
      and(
        eq(ended.conversationId, conversationId),
        inArray(ended.type, ["turn_completed", "turn_failed"]),
        lt(ended.seq, sql`(${turnStart})`),
      ),
    );
}

/** Read which children that the page's subagent events name are Threads. */
async function readThreadIds(
  executor: JuniorSqlDatabase,
  events: readonly ConversationEvent[],
): Promise<Set<string>> {
  const ids = [
    ...new Set(
      events.flatMap((event) =>
        event.data.type === "subagent_started"
          ? [event.data.childConversationId]
          : [],
      ),
    ),
  ];
  if (ids.length === 0) return new Set();
  const rows = await executor
    .db()
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        inArray(juniorConversations.conversationId, ids),
        eq(juniorConversations.kind, "thread"),
      ),
    );
  return new Set(rows.map((row) => row.conversationId));
}

/** Read the first Turn start, which marks history inherited from a fork. */
async function readFirstTurnStart(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<ConversationEvent | undefined> {
  const [row] = await readConversationEventRows(executor, {
    conversationId,
    direction: "forward",
    limit: 1,
    types: ["turn_started"],
  });
  return row ? eventFromRow(row) : undefined;
}

// Decoding and projection run on the request thread between queries.
// Without spans, their time is a gap in the request trace.
function projectEventPage(
  args: Parameters<typeof projectConversationReportEventPage>[0],
): ConversationReportEvent[] {
  return startSpan(
    {
      attributes: { "app.conversation.event.count": args.events.length },
      name: "Project conversation events",
      op: "function",
    },
    () => projectConversationReportEventPage(args),
  );
}

/** Resolve entity starts that precede the page, then project it once. */
async function projectConversationEvents(
  executor: JuniorSqlDatabase,
  args: {
    canExposePayload: boolean;
    conversationId: string;
    events: ConversationEvent[];
    firstTurnStart?: ConversationEvent;
  },
): Promise<ConversationReportEvent[]> {
  const events = args.events.sort((left, right) => left.seq - right.seq);
  const firstSeq = events[0]?.seq;
  const endedInvocationIds = [
    ...new Set(
      events.flatMap((event) =>
        event.data.type === "subagent_ended"
          ? [event.data.subagentInvocationId]
          : [],
      ),
    ),
  ];
  const toolResultIds = conversationReportToolResultIds(events);
  // These reads depend only on the page, so they run together.
  const [turnBoundaryRows, modelCallRows, subagentStartRows, toolStartRows] =
    await Promise.all([
      // Resolve context before the page, not from today's model config.
      // Keep the last Turn boundary and actual call so pages have the same
      // model.
      firstSeq === undefined
        ? []
        : readConversationEventRows(executor, {
            conversationId: args.conversationId,
            beforeSeq: firstSeq,
            direction: "backward",
            limit: 1,
            types: ["turn_started", "turn_completed", "turn_failed"],
          }),
      firstSeq === undefined
        ? []
        : readConversationEventRows(executor, {
            conversationId: args.conversationId,
            beforeSeq: firstSeq,
            direction: "backward",
            limit: 1,
            types: ["assistant_message"],
          }),
      endedInvocationIds.length === 0
        ? []
        : readConversationEventRows(executor, {
            conversationId: args.conversationId,
            direction: "forward",
            limit: endedInvocationIds.length,
            subagentInvocationIds: endedInvocationIds,
            types: ["subagent_started"],
          }),
      toolResultIds.length === 0
        ? []
        : readConversationEventRows(executor, {
            conversationId: args.conversationId,
            direction: "forward",
            limit: toolResultIds.length,
            toolCallIds: toolResultIds,
            types: ["tool_execution_started"],
          }),
      args.canExposePayload
        ? hydrateMessageAttachments(executor, args.conversationId, events)
        : undefined,
    ]);

  const subagentStartEvents = subagentStartRows.map(eventFromRow);
  // Ended events name their child only through the start they resolve.
  const threadIds = await readThreadIds(executor, [
    ...events,
    ...subagentStartEvents,
  ]);
  return projectEventPage({
    canExposePayload: args.canExposePayload,
    events,
    ...(args.firstTurnStart
      ? { firstTurnStart: args.firstTurnStart }
      : undefined),
    subagentStartEvents,
    threadIds,
    toolStartEvents: toolStartRows.map(eventFromRow),
    modelContextEvents: [...turnBoundaryRows, ...modelCallRows]
      .sort((left, right) => left.seq - right.seq)
      .map(eventFromRow),
  });
}

/**
 * Scan source rows in bounded chunks until more than `limit` reporting
 * events are known, then project the scanned rows once.
 *
 * Each chunk is decoded once. A chunk is counted without the entity starts
 * that precede it, which can only undercount, so the scan never stops early.
 */
async function scanConversationEventPage(
  executor: JuniorSqlDatabase,
  args: {
    afterSeq?: number | SQL;
    beforeSeq?: number | undefined;
    canExposePayload: boolean;
    conversationId: string;
    direction: "backward" | "forward";
    limit: number;
  },
): Promise<ConversationReportEvent[]> {
  const scanSize = Math.max(args.limit + 1, MIN_SCAN_SIZE);
  const firstTurnStartRead = readFirstTurnStart(executor, args.conversationId);
  const events: ConversationEvent[] = [];
  let { afterSeq, beforeSeq } = args;
  let firstTurnStart: ConversationEvent | undefined;
  let counted = 0;

  while (counted <= args.limit) {
    const [batch, turnStart] = await Promise.all([
      readConversationEventRows(executor, {
        afterSeq,
        beforeSeq,
        conversationId: args.conversationId,
        direction: args.direction,
        limit: scanSize,
      }),
      firstTurnStartRead,
    ]);
    firstTurnStart = turnStart;
    if (batch.length === 0) break;

    const decoded = startSpan(
      {
        attributes: { "app.conversation.event.count": batch.length },
        name: "Decode conversation events",
        op: "function",
      },
      () => batch.map(eventFromRow).sort((left, right) => left.seq - right.seq),
    );
    events.push(...decoded);
    counted += projectEventPage({
      canExposePayload: args.canExposePayload,
      events: decoded,
      ...(firstTurnStart ? { firstTurnStart } : undefined),
    }).length;
    if (batch.length < scanSize) break;
    if (args.direction === "backward") beforeSeq = batch.at(-1)!.seq;
    else afterSeq = batch.at(-1)!.seq;
  }

  return projectConversationEvents(executor, {
    canExposePayload: args.canExposePayload,
    conversationId: args.conversationId,
    events,
    ...(firstTurnStart ? { firstTurnStart } : undefined),
  });
}

/**
 * Read the latest reporting events before an exclusive boundary.
 *
 * Not every agent history event produces a reporting event, so source rows
 * are scanned until the requested page and one older event are known. With
 * `latestTurns`, the page also starts after the Turn before the latest
 * Turns, so it holds whole Turns when they fit in `limit`.
 */
export async function readConversationEventPage(
  executor: JuniorSqlDatabase,
  args: {
    beforeSeq?: number | undefined;
    canExposePayload: boolean;
    conversationId: string;
    latestTurns?: number | undefined;
    limit: number;
  },
): Promise<{
  events: ConversationReportEvent[];
  previousSeq?: number;
}> {
  const { latestTurns, ...pageArgs } = args;
  const pageStart =
    latestTurns === undefined
      ? undefined
      : readLatestTurnsPageStart(executor, args.conversationId, latestTurns);
  // The row read embeds the start lookup, so the page costs no extra round
  // trip. The same lookup runs beside it to tell whether events precede it.
  const [projected, startRows] = await Promise.all([
    scanConversationEventPage(executor, {
      ...pageArgs,
      ...(pageStart
        ? { afterSeq: sql`coalesce((${pageStart}), -1)` }
        : undefined),
      direction: "backward",
    }),
    pageStart,
  ]);
  const events = projected.slice(-args.limit);
  // A start seq is a Turn end, which is a reporting event before the page.
  const hasEarlier =
    projected.length > events.length || (startRows?.[0]?.seq ?? null) !== null;
  return {
    events,
    ...(hasEarlier && events[0] ? { previousSeq: events[0].seq } : undefined),
  };
}

/**
 * Read reporting events on both sides of one event.
 *
 * Half of the page ends with the event at `seq`, and the rest follows it. A
 * reader who opens at a read position gets the context before it and the
 * unread events after it in one page.
 */
export async function readConversationEventPageAround(
  executor: JuniorSqlDatabase,
  args: {
    canExposePayload: boolean;
    conversationId: string;
    limit: number;
    seq: number;
  },
): Promise<{
  events: ConversationReportEvent[];
  nextSeq?: number;
  previousSeq?: number;
}> {
  const { seq, ...pageArgs } = args;
  const beforeLimit = Math.floor(args.limit / 2);
  const [before, after] = await Promise.all([
    beforeLimit > 0
      ? readConversationEventPage(executor, {
          ...pageArgs,
          beforeSeq: seq + 1,
          limit: beforeLimit,
        })
      : undefined,
    readConversationEventPageAfter(executor, {
      ...pageArgs,
      afterSeq: seq,
      limit: args.limit - beforeLimit,
    }),
  ]);
  return {
    events: [...(before?.events ?? []), ...after.events],
    ...(after.nextSeq === undefined ? undefined : { nextSeq: after.nextSeq }),
    ...(before?.previousSeq === undefined
      ? undefined
      : { previousSeq: before.previousSeq }),
  };
}

/**
 * Read the earliest reporting events after an exclusive boundary.
 *
 * This is the forward twin of `readConversationEventPage`. It returns
 * `nextSeq` when newer events follow the page. Earlier pages start from the
 * page around the read position, so this page reads nothing before it.
 */
export async function readConversationEventPageAfter(
  executor: JuniorSqlDatabase,
  args: {
    afterSeq: number;
    canExposePayload: boolean;
    conversationId: string;
    limit: number;
  },
): Promise<{
  events: ConversationReportEvent[];
  nextSeq?: number;
}> {
  const projected = await scanConversationEventPage(executor, {
    ...args,
    direction: "forward",
  });
  const events = projected.slice(0, args.limit);
  return {
    events,
    ...(projected.length > events.length
      ? { nextSeq: events.at(-1)!.seq }
      : undefined),
  };
}

/** Read the newest event position, or -1 before the first event. */
export async function readConversationLastEventSeq(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<number> {
  const [row] = await executor
    .db()
    .select({ seq: max(juniorConversationEvents.seq) })
    .from(juniorConversationEvents)
    .where(eq(juniorConversationEvents.conversationId, conversationId));
  return row?.seq ?? -1;
}

/** Read the transcript position of one Message, when a Turn has read it. */
export async function readConversationMessageEventSeq(
  executor: JuniorSqlDatabase,
  conversationId: string,
  messageId: string,
): Promise<number | undefined> {
  const [row] = await executor
    .db()
    .select({ seq: juniorConversationEvents.seq })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "message"),
        sql`${juniorConversationEvents.payload}->>'messageId' = ${messageId}`,
      ),
    )
    .orderBy(asc(juniorConversationEvents.seq))
    .limit(1);
  return row?.seq;
}
