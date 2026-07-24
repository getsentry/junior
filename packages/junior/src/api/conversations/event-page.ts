import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  lt,
  lte,
  sql,
} from "drizzle-orm";
import {
  decodeStoredConversationEvent,
  type ConversationEvent,
} from "@/chat/conversations/history";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";
import type { ConversationReportEvent } from "../schema/conversation";
import {
  conversationReportSourceEventTypes,
  projectConversationReportEventPage,
} from "./events";

const conversationEventColumns = getTableColumns(juniorConversationEvents);
const MIN_SCAN_SIZE = 64;

type ConversationEventRow = Awaited<
  ReturnType<typeof readConversationEventRows>
>[number];

async function readConversationEventRows(
  executor: JuniorSqlDatabase,
  args: {
    afterSeq?: number;
    beforeSeq?: number;
    conversationId: string;
    direction: "backward" | "forward";
    limit: number;
    subagentInvocationIds?: string[];
    throughSeq?: number;
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
        args.afterSeq === undefined
          ? undefined
          : gt(juniorConversationEvents.seq, args.afterSeq),
        args.beforeSeq === undefined
          ? undefined
          : lt(juniorConversationEvents.seq, args.beforeSeq),
        args.throughSeq === undefined
          ? undefined
          : lte(juniorConversationEvents.seq, args.throughSeq),
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
      ),
    )
    .orderBy(
      args.direction === "forward"
        ? asc(juniorConversationEvents.seq)
        : desc(juniorConversationEvents.seq),
    )
    .limit(args.limit);
}

function decodeConversationEventRow(
  row: ConversationEventRow,
): ConversationEvent {
  return decodeStoredConversationEvent({
    schemaVersion: row.schemaVersion,
    seq: row.seq,
    historyVersion: row.historyVersion,
    ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    createdAtMs: row.createdAt.getTime(),
    type: row.type,
    payload: row.payload,
  });
}

async function projectConversationEventRows(
  executor: JuniorSqlDatabase,
  args: {
    canExposePayload: boolean;
    conversationId: string;
    rows: ConversationEventRow[];
  },
): Promise<ConversationReportEvent[]> {
  const events = args.rows
    .map(decodeConversationEventRow)
    .sort((left, right) => left.seq - right.seq);
  const endedInvocationIds = [
    ...new Set(
      events.flatMap((event) =>
        event.data.type === "subagent_ended"
          ? [event.data.subagentInvocationId]
          : [],
      ),
    ),
  ];
  const subagentStartRows =
    endedInvocationIds.length === 0
      ? []
      : await readConversationEventRows(executor, {
          conversationId: args.conversationId,
          direction: "forward",
          limit: endedInvocationIds.length,
          subagentInvocationIds: endedInvocationIds,
          types: ["subagent_started"],
        });

  return projectConversationReportEventPage({
    canExposePayload: args.canExposePayload,
    events,
    subagentStartEvents: subagentStartRows.map(decodeConversationEventRow),
  });
}

/** Read the current canonical event sequence used to anchor a stable page. */
export async function readConversationEventHighWaterSeq(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<number> {
  const [row] = await executor
    .db()
    .select({
      seq: sql<number | null>`max(${juniorConversationEvents.seq})::integer`,
    })
    .from(juniorConversationEvents)
    .where(eq(juniorConversationEvents.conversationId, conversationId));
  return row?.seq ?? -1;
}

/**
 * Read the latest reporting events before an exclusive boundary.
 *
 * Source rows are scanned in bounded chunks until the requested projected page
 * and one older event are known. This keeps ordinary pages bounded without
 * assuming every canonical agent step produces a reporting event.
 */
export async function readConversationEventPage(
  executor: JuniorSqlDatabase,
  args: {
    beforeSeq?: number;
    canExposePayload: boolean;
    conversationId: string;
    limit: number;
    throughSeq?: number;
  },
): Promise<{
  events: ConversationReportEvent[];
  previousSeq?: number;
}> {
  const scanSize = Math.max(args.limit + 1, MIN_SCAN_SIZE);
  const rows: ConversationEventRow[] = [];
  let beforeSeq = args.beforeSeq;
  let projected: ConversationReportEvent[] = [];

  while (projected.length <= args.limit) {
    const batch = await readConversationEventRows(executor, {
      beforeSeq,
      conversationId: args.conversationId,
      direction: "backward",
      limit: scanSize,
      throughSeq: args.throughSeq,
    });
    if (batch.length === 0) break;

    rows.push(...batch);
    projected = await projectConversationEventRows(executor, {
      canExposePayload: args.canExposePayload,
      conversationId: args.conversationId,
      rows,
    });
    if (projected.length > args.limit || batch.length < scanSize) break;
    beforeSeq = batch.at(-1)!.seq;
  }

  const events = projected.slice(-args.limit);
  return {
    events,
    ...(projected.length > events.length && events[0]
      ? { previousSeq: events[0].seq }
      : {}),
  };
}

/**
 * Read a bounded forward reporting page through a stable high-water sequence.
 *
 * The returned sequence advances over scanned source rows and over unrelated
 * canonical rows once no reporting source rows remain.
 */
export async function readConversationEventUpdates(
  executor: JuniorSqlDatabase,
  args: {
    afterSeq: number;
    canExposePayload: boolean;
    conversationId: string;
    limit: number;
    throughSeq: number;
  },
): Promise<{
  cursorSeq: number;
  events: ConversationReportEvent[];
  hasMore: boolean;
}> {
  const scanSize = Math.max(args.limit + 1, MIN_SCAN_SIZE);
  const events: ConversationReportEvent[] = [];
  let cursorSeq = args.afterSeq;

  while (cursorSeq < args.throughSeq && events.length < args.limit) {
    const rows = await readConversationEventRows(executor, {
      afterSeq: cursorSeq,
      conversationId: args.conversationId,
      direction: "forward",
      limit: scanSize,
      throughSeq: args.throughSeq,
    });
    if (rows.length === 0) {
      cursorSeq = args.throughSeq;
      break;
    }

    const projected = await projectConversationEventRows(executor, {
      canExposePayload: args.canExposePayload,
      conversationId: args.conversationId,
      rows,
    });
    const remaining = args.limit - events.length;
    if (projected.length > remaining) {
      const selected = projected.slice(0, remaining);
      events.push(...selected);
      cursorSeq = selected.at(-1)!.seq;
      break;
    }

    events.push(...projected);
    cursorSeq = rows.at(-1)!.seq;
    if (rows.length < scanSize) {
      cursorSeq = args.throughSeq;
      break;
    }
  }

  return {
    cursorSeq,
    events,
    hasMore: cursorSeq < args.throughSeq,
  };
}
