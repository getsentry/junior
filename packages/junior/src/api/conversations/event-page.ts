import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  lt,
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
  conversationReportToolResultIds,
  conversationReportSourceEventTypes,
  projectConversationReportEventPage,
} from "./events";

const conversationEventColumns = getTableColumns(juniorConversationEvents);
const MIN_SCAN_SIZE = 64;

type ConversationEventRow = Awaited<
  ReturnType<typeof readConversationEventRows>
>[number];

/** Read bounded canonical rows while excluding model-only replacement history. */
async function readConversationEventRows(
  executor: JuniorSqlDatabase,
  args: {
    beforeSeq?: number;
    conversationId: string;
    direction: "backward" | "forward";
    limit?: number;
    subagentInvocationIds?: string[];
    toolCallIds?: string[];
    turnIds?: string[];
    types?: ConversationEvent["data"]["type"][];
  },
) {
  const query = executor
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
              sql<string>`coalesce(
                ${juniorConversationEvents.payload}->>'toolCallId',
                ${juniorConversationEvents.payload}->'message'->>'toolCallId'
              )`,
              args.toolCallIds,
            ),
        args.turnIds === undefined
          ? undefined
          : inArray(
              sql<string>`${juniorConversationEvents.payload}->>'turnId'`,
              args.turnIds,
            ),
      ),
    )
    .orderBy(
      args.direction === "forward"
        ? asc(juniorConversationEvents.seq)
        : desc(juniorConversationEvents.seq),
    );
  return args.limit === undefined ? query : query.limit(args.limit);
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

/** Project stored rows and resolve entity starts that precede the page. */
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
  const failedTurnIds = [
    ...new Set(
      events.flatMap((event) =>
        event.data.type === "turn_failed" ? [event.data.turnId] : [],
      ),
    ),
  ];
  const failedTurnToolStartRows =
    failedTurnIds.length === 0
      ? []
      : await readConversationEventRows(executor, {
          conversationId: args.conversationId,
          direction: "forward",
          turnIds: failedTurnIds,
          types: ["tool_execution_started"],
        });
  const toolResultIds = conversationReportToolResultIds(events);
  const toolStartIds = [
    ...new Set([
      ...toolResultIds,
      ...failedTurnToolStartRows.map((row) => row.payload.toolCallId as string),
    ]),
  ];
  const toolStartRows =
    toolStartIds.length === 0
      ? []
      : await readConversationEventRows(executor, {
          conversationId: args.conversationId,
          direction: "forward",
          limit: toolStartIds.length,
          toolCallIds: toolStartIds,
          types: ["tool_execution_started"],
        });
  const toolResultRows =
    failedTurnToolStartRows.length === 0
      ? []
      : await readConversationEventRows(executor, {
          conversationId: args.conversationId,
          direction: "forward",
          toolCallIds: failedTurnToolStartRows.map(
            (row) => row.payload.toolCallId as string,
          ),
          types: ["agent_step"],
        });

  return projectConversationReportEventPage({
    canExposePayload: args.canExposePayload,
    events,
    subagentStartEvents: subagentStartRows.map(decodeConversationEventRow),
    toolResultEvents: toolResultRows.map(decodeConversationEventRow),
    toolStartEvents: toolStartRows.map(decodeConversationEventRow),
  });
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
