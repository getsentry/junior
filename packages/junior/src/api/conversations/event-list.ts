import type { User } from "@sentry/junior-plugin-api";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { readConversationAccessFromSql } from "./access";
import { decodeConversationCursor, encodeConversationCursor } from "./cursor";
import {
  readConversationEventPage,
  readConversationEventPageAfter,
  readConversationEventPageAround,
} from "./event-page";
import { attachConversationMentions } from "./mentions";
import { readConversationRecordFromSql } from "./list";
import { conversationEventHistory } from "./projection";
import { throwApiError } from "../http";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";
import {
  conversationEventPageSchema,
  type ConversationEventPage,
  type ConversationReportEvent,
} from "../schema/conversation";

/**
 * Where one page starts. Cursors come from earlier pages. A link target
 * (`event` seq or `turn` id) asks for the page around it, so the dashboard
 * opens a linked row with one request.
 */
type ConversationEventsBoundary =
  | { after: string }
  | { around: string }
  | { before: string }
  | { event: number }
  | { turn: string };

/** Read one bounded page of reporting events before, after, or around a boundary. */
export async function readConversationEvents(
  conversationId: string,
  boundary: ConversationEventsBoundary,
  options: {
    limit?: number;
    viewer?: User;
  } = {},
): Promise<ConversationEventPage | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;

  const position = await boundaryPosition(conversationId, boundary);
  const accessByConversation = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    options.viewer,
  );
  const access = accessByConversation.get(conversationId);
  const canExposePayload = access?.canViewPrivateContent ?? false;
  const transcriptPurgedAtMs = record.conversation.transcriptPurgedAtMs;
  const pageArgs = {
    canExposePayload,
    conversationId,
    limit: options.limit ?? 500,
  };
  const page: Awaited<ReturnType<typeof readConversationEventPageAround>> =
    transcriptPurgedAtMs !== undefined
      ? { events: [] }
      : position.direction === "after"
        ? await readConversationEventPageAfter(getSqlExecutor(), {
            ...pageArgs,
            afterSeq: position.seq,
          })
        : position.direction === "around"
          ? await readConversationEventPageAround(getSqlExecutor(), {
              ...pageArgs,
              seq: position.seq,
            })
          : await readConversationEventPage(getSqlExecutor(), {
              ...pageArgs,
              beforeSeq: position.seq,
            });
  return conversationEventPageSchema.parse(
    await conversationEventPageReport(getSqlExecutor(), {
      conversationId,
      eventHistory: conversationEventHistory({
        canExposePayload,
        ...(transcriptPurgedAtMs === undefined
          ? undefined
          : { transcriptPurgedAtMs }),
      }),
      page,
    }),
  );
}

/** Resolve a page boundary to a direction and an event seq. */
async function boundaryPosition(
  conversationId: string,
  boundary: ConversationEventsBoundary,
): Promise<{ direction: "after" | "around" | "before"; seq: number }> {
  if ("event" in boundary) return { direction: "around", seq: boundary.event };
  if ("turn" in boundary) {
    const seq = await readTurnStartedSeq(conversationId, boundary.turn);
    if (seq === undefined) throwApiError(404, "Turn not found.");
    return { direction: "around", seq };
  }
  const [direction, value] =
    "after" in boundary
      ? (["after", boundary.after] as const)
      : "around" in boundary
        ? (["around", boundary.around] as const)
        : (["before", boundary.before] as const);
  const cursor = decodeConversationCursor({ conversationId, cursor: value });
  if (!cursor) throwApiError(400, "Invalid conversation cursor.");
  return { direction, seq: cursor.seq };
}

/**
 * Find the event that started a Turn. The `(conversation_id, type, seq)`
 * index reads only this Conversation's `turn_started` rows.
 */
async function readTurnStartedSeq(
  conversationId: string,
  turnId: string,
): Promise<number | undefined> {
  const [row] = await getDb()
    .select({ seq: juniorConversationEvents.seq })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "turn_started"),
        sql`${juniorConversationEvents.payload}->>'turnId' = ${turnId}`,
      ),
    )
    .limit(1);
  return row?.seq;
}

/** Attach mentions and signed cursors to one bounded page of events. */
export async function conversationEventPageReport(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    eventHistory: ConversationEventPage["eventHistory"];
    page: {
      events: ConversationReportEvent[];
      nextSeq?: number;
      previousSeq?: number;
    };
  },
): Promise<ConversationEventPage> {
  const { conversationId, page } = args;
  const cursorAt = (seq: number) =>
    encodeConversationCursor({ conversationId, seq });
  return {
    events: (
      await attachConversationMentions(executor, conversationId, {
        events: page.events,
      })
    ).events,
    eventHistory: args.eventHistory,
    ...(page.previousSeq === undefined
      ? undefined
      : { previousCursor: cursorAt(page.previousSeq) }),
    ...(page.nextSeq === undefined
      ? undefined
      : { nextCursor: cursorAt(page.nextSeq) }),
    generatedAt: new Date().toISOString(),
  };
}
