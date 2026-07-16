import { getChatConfig } from "@/chat/config";
import { isRecord, toOptionalString } from "@/chat/coerce";
import type { ConversationMessageRole } from "@/chat/conversations/messages";
import {
  conversationEventDataSchema,
  newConversationEventSchema,
  type NewConversationEvent,
} from "@/chat/conversations/history";
import type { JuniorSqlExecutor } from "@/db/db";
import { createJuniorSqlExecutor } from "@/db/executor";
import { sanitizePostgresJson } from "@/db/postgres-json";
import type { MigrationContext, MigrationResult } from "../types";

const VISIBLE_EVENT_BATCH_SIZE = 500;
const VISIBLE_EVENT_BACKFILL_LOCK =
  "junior:upgrade:conversation-visible-message-events";
const AGENT_TURN_SESSION_PREFIX = "junior:agent_turn_session";

const LOAD_VISIBLE_CONVERSATION_IDS_SQL = `
SELECT DISTINCT conversation_id
FROM junior_conversation_messages
WHERE $2::text IS NULL OR conversation_id > $2::text
ORDER BY conversation_id
LIMIT $1
`;

const LOAD_MISSING_VISIBLE_EVENTS_SQL = `
SELECT
  message.conversation_id,
  message.message_id,
  message.role,
  message.text,
  message.author_identity_id,
  message.meta,
  message.replied_at,
  message.created_at
FROM junior_conversation_messages message
WHERE (
  NOT EXISTS (
    SELECT 1
    FROM junior_conversation_events event
    WHERE event.conversation_id = message.conversation_id
      AND event.idempotency_key =
        'visible-message:' || message.message_id || ':recorded'
  )
  OR (
    message.replied_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM junior_conversation_events event
      WHERE event.conversation_id = message.conversation_id
        AND event.idempotency_key =
          'visible-message:' || message.message_id || ':replied'
    )
  )
)
AND (
  $2::text IS NULL
  OR (message.conversation_id, message.created_at, message.message_id) >
    ($2::text, $3::timestamptz, $4::text)
)
ORDER BY message.conversation_id, message.created_at, message.message_id
LIMIT $1
`;

const COUNT_MISSING_VISIBLE_EVENTS_SQL = `
SELECT count(*)::integer AS count
FROM junior_conversation_messages message
WHERE NOT EXISTS (
  SELECT 1
  FROM junior_conversation_events event
  WHERE event.conversation_id = message.conversation_id
    AND event.idempotency_key =
      'visible-message:' || message.message_id || ':recorded'
)
OR (
  message.replied_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM junior_conversation_events event
    WHERE event.conversation_id = message.conversation_id
      AND event.idempotency_key =
        'visible-message:' || message.message_id || ':replied'
  )
)
`;

interface VisibleMessageRow {
  conversation_id: string;
  message_id: string;
  role: ConversationMessageRole;
  text: string;
  author_identity_id: string | null;
  meta: Record<string, unknown> | null;
  replied_at: Date | string | null;
  created_at: Date | string;
}

interface VisibleConversationRow {
  conversation_id: string;
}

interface SqlVisibleEvent {
  createdAtMs: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  type: string;
}

function timestampMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function eventsForRow(row: VisibleMessageRow): NewConversationEvent[] {
  const events: NewConversationEvent[] = [
    {
      idempotencyKey: `visible-message:${row.message_id}:recorded`,
      data: {
        type: "visible_message_recorded",
        messageId: row.message_id,
        role: row.role,
        text: row.text,
        ...(row.author_identity_id
          ? { authorIdentityId: row.author_identity_id }
          : {}),
        ...(row.meta ? { meta: row.meta } : {}),
      },
      createdAtMs: timestampMs(row.created_at),
    },
  ];
  if (row.replied_at) {
    events.push({
      idempotencyKey: `visible-message:${row.message_id}:replied`,
      data: { type: "visible_message_replied", messageId: row.message_id },
      createdAtMs: timestampMs(row.replied_at),
    });
  }
  return events;
}

function turnSessionConversationIndexKey(conversationId: string): string {
  return `${AGENT_TURN_SESSION_PREFIX}:conversation:${conversationId}:index`;
}

function turnSessionRecordKey(
  conversationId: string,
  sessionId: string,
): string {
  return `${AGENT_TURN_SESSION_PREFIX}:${conversationId}:${sessionId}`;
}

async function indexedTurnSessionIds(
  context: MigrationContext,
  conversationId: string,
): Promise<string[]> {
  const summaries = await context.stateAdapter.getList(
    turnSessionConversationIndexKey(conversationId),
  );
  return [
    ...new Set(
      summaries.flatMap((summary) => {
        if (!isRecord(summary)) return [];
        const sessionId = toOptionalString(summary.sessionId);
        return sessionId ? [sessionId] : [];
      }),
    ),
  ];
}

function hasSeqCursor(record: Record<string, unknown>): boolean {
  return (
    Number.isInteger(record.committedSeq) ||
    Number.isInteger(record.turnStartSeq)
  );
}

async function visitVisibleConversations(
  executor: JuniorSqlExecutor,
  batchSize: number,
  visit: (conversationId: string) => Promise<void>,
): Promise<void> {
  let cursor: string | undefined;
  while (true) {
    const rows = await executor.query<VisibleConversationRow>(
      LOAD_VISIBLE_CONVERSATION_IDS_SQL,
      [batchSize, cursor ?? null],
    );
    if (rows.length === 0) return;
    for (const row of rows) {
      await visit(row.conversation_id);
    }
    cursor = rows.at(-1)!.conversation_id;
  }
}

/** Refuse to resequence while a resumable Redis cursor can still be consumed. */
async function assertNoUnfinishedTurnCursors(
  context: MigrationContext,
  executor: JuniorSqlExecutor,
  batchSize: number,
): Promise<void> {
  await context.stateAdapter.connect();
  await visitVisibleConversations(
    executor,
    batchSize,
    async (conversationId) => {
      for (const sessionId of await indexedTurnSessionIds(
        context,
        conversationId,
      )) {
        const key = turnSessionRecordKey(conversationId, sessionId);
        const value = await context.stateAdapter.get<unknown>(key);
        if (!isRecord(value) || !hasSeqCursor(value)) continue;
        if (value.state === "running" || value.state === "awaiting_resume") {
          throw new Error(
            `Cannot resequence conversation events while unfinished turn session ${key} retains a seq cursor`,
          );
        }
        if (
          value.state !== "completed" &&
          value.state !== "failed" &&
          value.state !== "abandoned"
        ) {
          throw new Error(
            `Cannot resequence conversation events with invalid cursor-bearing turn session ${key}`,
          );
        }
      }
    },
  );
}

/** Invalidate terminal physical-seq cursors before the chronological hard cut. */
async function invalidateTerminalTurnCursors(
  context: MigrationContext,
  executor: JuniorSqlExecutor,
  batchSize: number,
): Promise<void> {
  await visitVisibleConversations(
    executor,
    batchSize,
    async (conversationId) => {
      for (const sessionId of await indexedTurnSessionIds(
        context,
        conversationId,
      )) {
        const key = turnSessionRecordKey(conversationId, sessionId);
        const value = await context.stateAdapter.get<unknown>(key);
        if (isRecord(value) && hasSeqCursor(value)) {
          await context.stateAdapter.delete(key);
        }
      }
    },
  );
}

function sqlVisibleEvents(events: NewConversationEvent[]): SqlVisibleEvent[] {
  return events.map((event) => {
    const parsed = newConversationEventSchema.parse(event);
    if (!parsed.idempotencyKey) {
      throw new Error(
        "Visible-message backfill events require idempotency keys",
      );
    }
    const { type, ...payload } = conversationEventDataSchema.parse(parsed.data);
    return {
      createdAtMs: parsed.createdAtMs,
      idempotencyKey: parsed.idempotencyKey,
      payload: sanitizePostgresJson(payload),
      type,
    };
  });
}

/** Insert missing facts and resequence one conversation in a single SQL lock. */
async function mergeVisibleEvents(
  executor: JuniorSqlExecutor,
  conversationId: string,
  events: NewConversationEvent[],
): Promise<void> {
  const encoded = sqlVisibleEvents(events);
  await executor.withLock(
    `junior_conversation:event:${conversationId}`,
    async () => {
      await executor.transaction(async () => {
        await executor.execute(
          `WITH input AS (
             SELECT *
             FROM jsonb_to_recordset($2::jsonb) AS event(
               "createdAtMs" bigint,
               "idempotencyKey" text,
               payload jsonb,
               type text
             )
           ), base AS (
             SELECT coalesce(max(seq), -1) AS max_seq
             FROM junior_conversation_events
             WHERE conversation_id = $1
           ), pending AS (
             SELECT
               input.*,
               row_number() OVER (
                 ORDER BY input."createdAtMs", input."idempotencyKey"
               ) AS offset
             FROM input
             WHERE NOT EXISTS (
               SELECT 1
               FROM junior_conversation_events existing
               WHERE existing.conversation_id = $1
                 AND existing.idempotency_key = input."idempotencyKey"
             )
           )
           INSERT INTO junior_conversation_events (
             conversation_id,
             seq,
             context_epoch,
             schema_version,
             idempotency_key,
             type,
             payload,
             created_at
           )
           SELECT
             $1,
             base.max_seq + pending.offset,
             coalesce((
               SELECT prior.context_epoch
               FROM junior_conversation_events prior
               WHERE prior.conversation_id = $1
                 AND prior.created_at < to_timestamp(pending."createdAtMs" / 1000.0)
               ORDER BY prior.seq DESC
               LIMIT 1
             ), 0),
             1,
             pending."idempotencyKey",
             pending.type,
             pending.payload,
             to_timestamp(pending."createdAtMs" / 1000.0)
           FROM pending
           CROSS JOIN base
           ON CONFLICT (conversation_id, idempotency_key) DO NOTHING`,
          [conversationId, JSON.stringify(encoded)],
        );
        await executor.execute(
          `UPDATE junior_conversation_events
           SET seq = -seq - 1
           WHERE conversation_id = $1`,
          [conversationId],
        );
        await executor.execute(
          `WITH ranked AS (
             SELECT
               event.ctid,
               row_number() OVER (
                 ORDER BY
                   CASE
                     WHEN event.type IN (
                       'visible_message_recorded',
                       'visible_message_replied'
                     ) THEN coalesce((
                       SELECT max(-execution.seq - 1)
                       FROM junior_conversation_events execution
                       WHERE execution.conversation_id = event.conversation_id
                         AND execution.type NOT IN (
                           'visible_message_recorded',
                           'visible_message_replied'
                         )
                         AND execution.created_at < event.created_at
                     ), -1)
                     ELSE -event.seq - 1
                   END,
                   CASE
                     WHEN event.type IN (
                       'visible_message_recorded',
                       'visible_message_replied'
                     ) THEN 1
                     ELSE 0
                   END,
                   event.created_at,
                   CASE event.type
                     WHEN 'visible_message_recorded' THEN 0
                     WHEN 'visible_message_replied' THEN 1
                     ELSE 0
                   END,
                   event.idempotency_key NULLS FIRST,
                   event.type
               ) - 1 AS next_seq
             FROM junior_conversation_events event
             WHERE event.conversation_id = $1
           )
           UPDATE junior_conversation_events event
           SET seq = ranked.next_seq
           FROM ranked
           WHERE event.ctid = ranked.ctid`,
          [conversationId],
        );
      });
    },
  );
}

/**
 * Backfill canonical visible-message events from the SQL read model.
 *
 * This must run after the external legacy-history import. A visible-message
 * event is a completed-import seal, so running this from the schema migration
 * would hide richer retained Redis session and advisor history from import.
 */
export async function migrateConversationVisibleMessageEvents(
  context: MigrationContext,
  options: {
    batchSize?: number;
    executor?: JuniorSqlExecutor;
  } = {},
): Promise<MigrationResult> {
  let executor = options.executor;
  let closeExecutor: (() => Promise<void>) | undefined;
  if (!executor) {
    const { sql } = getChatConfig();
    executor = createJuniorSqlExecutor({
      connectionString: sql.databaseUrl,
      driver: sql.driver,
    });
    closeExecutor = () => executor!.close();
  }
  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? VISIBLE_EVENT_BATCH_SIZE),
  );
  let migrated = 0;
  let cursor:
    | { conversationId: string; createdAt: Date | string; messageId: string }
    | undefined;
  try {
    // This hard cut changes physical event positions. Drain resumable turns,
    // then invalidate terminal cursor records before any SQL sequence changes.
    await assertNoUnfinishedTurnCursors(context, executor, batchSize);
    await invalidateTerminalTurnCursors(context, executor, batchSize);
    while (true) {
      const rows = await executor.withLock(VISIBLE_EVENT_BACKFILL_LOCK, () =>
        executor.query<VisibleMessageRow>(LOAD_MISSING_VISIBLE_EVENTS_SQL, [
          batchSize,
          cursor?.conversationId ?? null,
          cursor?.createdAt ?? null,
          cursor?.messageId ?? null,
        ]),
      );
      if (rows.length === 0) {
        break;
      }
      const grouped = new Map<string, NewConversationEvent[]>();
      for (const row of rows) {
        const events = grouped.get(row.conversation_id) ?? [];
        events.push(...eventsForRow(row));
        grouped.set(row.conversation_id, events);
      }
      for (const [conversationId, events] of grouped) {
        await mergeVisibleEvents(executor, conversationId, events);
      }
      migrated += rows.length;
      const last = rows.at(-1)!;
      cursor = {
        conversationId: last.conversation_id,
        createdAt: last.created_at,
        messageId: last.message_id,
      };
    }
    const [remaining] = await executor.query<{ count: number }>(
      COUNT_MISSING_VISIBLE_EVENTS_SQL,
    );
    if (!remaining) {
      throw new Error(
        "Visible-message event migration could not verify its projection",
      );
    }
    if (remaining.count > 0) {
      throw new Error(
        `Visible-message event migration left ${remaining.count} message row(s) without canonical events`,
      );
    }
    return {
      existing: 0,
      migrated,
      missing: 0,
      scanned: migrated,
    };
  } finally {
    await closeExecutor?.();
  }
}

export const conversationVisibleMessageEventsMigration = {
  name: "backfill-conversation-visible-message-events",
  run: migrateConversationVisibleMessageEvents,
};
