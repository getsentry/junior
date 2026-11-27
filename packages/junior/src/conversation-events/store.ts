// Storage of a Conversation's events: one ordered list that core and the host
// both append to. It knows no event types. Each writer validates and encodes
// its own rows. Call these under `withConversationEventLock`.
import { and, eq, inArray, sql } from "drizzle-orm";
import { conversationDetailTouch } from "@/chat/conversations/sql/detail-version";
import type { JuniorSqlDatabase } from "@/db/db";
import { sanitizePostgresJson } from "@/db/postgres-json";
import { juniorConversationEvents } from "@/db/schema";

type EventRowInsert = typeof juniorConversationEvents.$inferInsert;

/** One validated, encoded event row to store. */
export type NewEventRow = {
  type: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  idempotencyKey?: string | undefined;
  actorIdentityId?: string | undefined;
  /** The Turn that writes the row, when a Turn writes it. */
  turnId?: string | undefined;
  createdAtMs: number;
};

/** Where the next event goes: its seq and the current History version. */
export type EventCursor = { nextSeq: number; historyVersion: number };

/** Read the next seq and the current History version of a Conversation. */
export async function readEventCursor(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<EventCursor> {
  const [row] = await executor
    .db()
    .select({
      maxSeq: sql<number | null>`max(${juniorConversationEvents.seq})`,
      maxHistoryVersion: sql<
        number | null
      >`max(${juniorConversationEvents.historyVersion})`,
    })
    .from(juniorConversationEvents)
    .where(eq(juniorConversationEvents.conversationId, conversationId));
  return {
    nextSeq: row?.maxSeq == null ? 0 : Number(row.maxSeq) + 1,
    historyVersion:
      row?.maxHistoryVersion == null ? 0 : Number(row.maxHistoryVersion),
  };
}

/**
 * Drop the events whose idempotency key is already stored, or repeats an
 * earlier event of the same call. Events without a key are always kept.
 */
export async function unseenEvents<T extends { idempotencyKey?: string }>(
  executor: JuniorSqlDatabase,
  conversationId: string,
  events: readonly T[],
): Promise<T[]> {
  const keys = events.flatMap((event) =>
    event.idempotencyKey === undefined ? [] : [event.idempotencyKey],
  );
  const seen = new Set<string>();
  if (keys.length > 0) {
    const rows = await executor
      .db()
      .select({ key: juniorConversationEvents.idempotencyKey })
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          inArray(juniorConversationEvents.idempotencyKey, keys),
        ),
      );
    for (const row of rows) if (row.key) seen.add(row.key);
  }
  return events.filter((event) => {
    if (event.idempotencyKey === undefined) return true;
    if (seen.has(event.idempotencyKey)) return false;
    seen.add(event.idempotencyKey);
    return true;
  });
}

/** Store rows in order from the cursor, at its History version. */
export async function insertEventRows(
  executor: JuniorSqlDatabase,
  conversationId: string,
  cursor: EventCursor,
  rows: readonly NewEventRow[],
): Promise<EventRowInsert[]> {
  return await insertAt(
    executor,
    conversationId,
    cursor.historyVersion,
    rows.map((row, index) => ({ row, seq: cursor.nextSeq + index })),
  );
}

/**
 * Store a History replacement row. It starts the next History version, so
 * every later row belongs to the history that it sets.
 */
export async function insertHistoryReplacementRow(
  executor: JuniorSqlDatabase,
  conversationId: string,
  cursor: EventCursor,
  row: NewEventRow,
): Promise<EventRowInsert> {
  const [inserted] = await insertAt(
    executor,
    conversationId,
    cursor.historyVersion + 1,
    [{ row, seq: cursor.nextSeq }],
  );
  return inserted!;
}

async function insertAt(
  executor: JuniorSqlDatabase,
  conversationId: string,
  historyVersion: number,
  rows: ReadonlyArray<{ row: NewEventRow; seq: number }>,
): Promise<EventRowInsert[]> {
  const values = rows.map(({ row, seq }): EventRowInsert => ({
    conversationId,
    seq,
    historyVersion,
    schemaVersion: row.schemaVersion,
    idempotencyKey: row.idempotencyKey ?? null,
    type: row.type,
    payload: sanitizePostgresJson(row.payload),
    actorIdentityId: row.actorIdentityId ?? null,
    turnId: row.turnId ?? null,
    createdAt: new Date(row.createdAtMs),
  }));
  if (values.length === 0) return [];
  const db = executor.db();
  await db
    .with(conversationDetailTouch(db, [conversationId]))
    .insert(juniorConversationEvents)
    .values(values);
  return values;
}
