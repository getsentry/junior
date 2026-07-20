import { getChatConfig } from "@/chat/config";
import { isRecord, toOptionalNumber, toOptionalString } from "@/chat/coerce";
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
import { prepareConversationEventResequence } from "./conversation-event-cursors";

const VISIBLE_EVENT_BATCH_SIZE = 500;
const VISIBLE_EVENT_BACKFILL_LOCK =
  "junior:upgrade:conversation-visible-message-events";
const LOAD_VISIBLE_CONVERSATION_IDS_SQL = `
SELECT DISTINCT conversation_id
FROM junior_conversation_messages
WHERE $2::text IS NULL OR conversation_id > $2::text
ORDER BY conversation_id
LIMIT $1
`;

const LOAD_COMPACTED_CONVERSATION_IDS_SQL = `
SELECT DISTINCT conversation_id
FROM junior_conversation_events
WHERE type = 'messages_summarized'
  AND payload @? '$.compactions[*].coveredMessageIds'
  AND ($2::text IS NULL OR conversation_id > $2::text)
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
        'message:' || message.message_id
  )
  OR (
    message.replied_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM junior_conversation_events event
      WHERE event.conversation_id = message.conversation_id
        AND event.idempotency_key =
          'message:' || message.message_id || ':handled'
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
      'message:' || message.message_id
)
OR (
  message.replied_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM junior_conversation_events event
    WHERE event.conversation_id = message.conversation_id
      AND event.idempotency_key =
        'message:' || message.message_id || ':handled'
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

interface VisibleCompactionAnchorRow {
  messageId: string | null;
}

interface LegacyCompactionState {
  compactedMessageCount?: number;
  liveMessageIds: Set<string>;
}

interface CompactionEventRow {
  payload: Record<string, unknown>;
  seq: number;
}

interface VisibleRecordedEventRow {
  messageId: string;
  seq: number;
}

function timestampMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function eventsForRow(row: VisibleMessageRow): NewConversationEvent[] {
  const events: NewConversationEvent[] = [
    {
      idempotencyKey: `message:${row.message_id}`,
      data: {
        type: "message",
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
      idempotencyKey: `message:${row.message_id}:handled`,
      data: { type: "message_handled", messageId: row.message_id },
      createdAtMs: timestampMs(row.replied_at),
    });
  }
  return events;
}

async function visitConversationIds(
  executor: JuniorSqlExecutor,
  query: string,
  batchSize: number,
  visit: (conversationId: string) => Promise<void>,
): Promise<void> {
  let cursor: string | undefined;
  while (true) {
    const rows = await executor.query<VisibleConversationRow>(query, [
      batchSize,
      cursor ?? null,
    ]);
    if (rows.length === 0) return;
    for (const row of rows) {
      await visit(row.conversation_id);
    }
    cursor = rows.at(-1)!.conversation_id;
  }
}

async function visitVisibleConversations(
  executor: JuniorSqlExecutor,
  batchSize: number,
  visit: (conversationId: string) => Promise<void>,
): Promise<void> {
  await visitConversationIds(
    executor,
    LOAD_VISIBLE_CONVERSATION_IDS_SQL,
    batchSize,
    visit,
  );
}

async function readLegacyCompactionState(
  context: MigrationContext,
  conversationId: string,
): Promise<LegacyCompactionState> {
  const raw = await context.stateAdapter.get<unknown>(
    `thread-state:${conversationId}`,
  );
  const conversation =
    isRecord(raw) && isRecord(raw.conversation) ? raw.conversation : undefined;
  const stats =
    conversation && isRecord(conversation.stats)
      ? conversation.stats
      : undefined;
  const rawCount = toOptionalNumber(stats?.compactedMessageCount);
  const compactedMessageCount =
    rawCount === undefined ? undefined : Math.max(0, Math.floor(rawCount));
  const messages =
    conversation && Array.isArray(conversation.messages)
      ? conversation.messages
      : [];
  const liveMessageIds = new Set(
    messages.flatMap((message) => {
      if (!isRecord(message)) return [];
      const id = toOptionalString(message.id);
      return id ? [id] : [];
    }),
  );
  return {
    ...(compactedMessageCount === undefined ? {} : { compactedMessageCount }),
    liveMessageIds,
  };
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

async function loadVisibleCompactionAnchor(
  executor: JuniorSqlExecutor,
  conversationId: string,
): Promise<VisibleCompactionAnchorRow | undefined> {
  const [row] = await executor.query<VisibleCompactionAnchorRow>(
    `WITH snapshot AS (
       SELECT payload
       FROM junior_conversation_events
       WHERE conversation_id = $1
         AND type = 'messages_summarized'
       ORDER BY seq DESC
       LIMIT 1
     )
     SELECT (
       SELECT event.payload->>'messageId'
       FROM junior_conversation_events event
       WHERE event.conversation_id = $1
         AND event.type = 'message'
         AND event.seq >= (snapshot.payload->>'historyFromSeq')::integer
       ORDER BY event.seq
       LIMIT 1
     ) AS "messageId"
     FROM snapshot`,
    [conversationId],
  );
  return row;
}

async function normalizeVisibleCompactionBoundary(
  executor: JuniorSqlExecutor,
  conversationId: string,
  anchor: VisibleCompactionAnchorRow | undefined,
): Promise<void> {
  if (!anchor) return;
  let historyFromSeq: number;
  if (anchor.messageId) {
    const [baseline] = await executor.query<{ seq: number }>(
      `SELECT seq
       FROM junior_conversation_events
       WHERE conversation_id = $1
         AND type = 'message'
         AND payload->>'messageId' = $2
       ORDER BY seq
       LIMIT 1`,
      [conversationId, anchor.messageId],
    );
    if (!baseline) {
      throw new Error(
        `Visible compaction anchor ${anchor.messageId} disappeared during resequence`,
      );
    }
    historyFromSeq = baseline.seq;
  } else {
    const [end] = await executor.query<{ seq: number }>(
      `SELECT coalesce(max(seq), -1)::integer + 1 AS seq
       FROM junior_conversation_events
       WHERE conversation_id = $1`,
      [conversationId],
    );
    historyFromSeq = end?.seq ?? 0;
  }
  await executor.execute(
    `WITH snapshot AS (
       SELECT ctid
       FROM junior_conversation_events
       WHERE conversation_id = $1
         AND type = 'messages_summarized'
       ORDER BY seq DESC
       LIMIT 1
     )
     UPDATE junior_conversation_events event
     SET payload = jsonb_set(
       event.payload,
       '{historyFromSeq}',
       to_jsonb($2::integer)
     )
     FROM snapshot
     WHERE event.ctid = snapshot.ctid`,
    [conversationId, historyFromSeq],
  );
}

function coveredMessageIds(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.compactions)) return [];
  return payload.compactions.flatMap((compaction) => {
    if (!isRecord(compaction) || !Array.isArray(compaction.coveredMessageIds)) {
      return [];
    }
    return compaction.coveredMessageIds.flatMap((id) => {
      const value = toOptionalString(id);
      return value ? [value] : [];
    });
  });
}

function retainedCompactionCount(payload: Record<string, unknown>): number {
  if (!Array.isArray(payload.compactions)) return 0;
  return payload.compactions.reduce((total, value) => {
    if (!isRecord(value)) return total;
    const stored = toOptionalNumber(value.coveredMessageCount);
    const legacy = Array.isArray(value.coveredMessageIds)
      ? value.coveredMessageIds.length
      : 0;
    return total + (stored === undefined ? legacy : Math.max(0, stored));
  }, 0);
}

function resolvedHistoryFromSeq(args: {
  currentHistoryFromSeq: number;
  endSeq: number;
  legacyCoveredMessageIds: string[];
  legacyState: LegacyCompactionState;
  visibleEvents: VisibleRecordedEventRow[];
}): number {
  if (args.legacyState.liveMessageIds.size > 0) {
    const live = args.visibleEvents.find((event) =>
      args.legacyState.liveMessageIds.has(event.messageId),
    );
    if (live) return live.seq;
  }
  if (args.legacyState.compactedMessageCount !== undefined) {
    return (
      args.visibleEvents[args.legacyState.compactedMessageCount]?.seq ??
      args.endSeq
    );
  }
  const coveredIds = new Set(args.legacyCoveredMessageIds);
  if (coveredIds.size > 0) {
    const lastCoveredSeq = args.visibleEvents.reduce(
      (last, event) =>
        coveredIds.has(event.messageId) ? Math.max(last, event.seq) : last,
      -1,
    );
    return (
      args.visibleEvents.find((event) => event.seq > lastCoveredSeq)?.seq ??
      args.endSeq
    );
  }
  return args.currentHistoryFromSeq > 0
    ? args.currentHistoryFromSeq
    : (args.visibleEvents[0]?.seq ?? args.endSeq);
}

/** Finalize transient pre-cutover compaction metadata after visible events exist. */
async function finalizeVisibleCompactions(
  context: MigrationContext,
  executor: JuniorSqlExecutor,
  conversationId: string,
): Promise<void> {
  const legacyState = await readLegacyCompactionState(context, conversationId);
  await executor.withLock(
    `junior_conversation:event:${conversationId}`,
    async () => {
      const [latest] = await executor.query<CompactionEventRow>(
        `SELECT seq, payload
         FROM junior_conversation_events
         WHERE conversation_id = $1
           AND type = 'messages_summarized'
         ORDER BY seq DESC
         LIMIT 1`,
        [conversationId],
      );
      if (!latest) return;
      const visibleEvents = await executor.query<VisibleRecordedEventRow>(
        `SELECT seq, payload->>'messageId' AS "messageId"
         FROM junior_conversation_events
         WHERE conversation_id = $1
           AND type = 'message'
         ORDER BY seq`,
        [conversationId],
      );
      const [cursor] = await executor.query<{ endSeq: number }>(
        `SELECT coalesce(max(seq), -1)::integer + 1 AS "endSeq"
         FROM junior_conversation_events
         WHERE conversation_id = $1`,
        [conversationId],
      );
      const currentHistoryFromSeq =
        toOptionalNumber(latest.payload.historyFromSeq) ?? 0;
      const historyFromSeq = resolvedHistoryFromSeq({
        currentHistoryFromSeq: Math.max(0, Math.floor(currentHistoryFromSeq)),
        endSeq: cursor?.endSeq ?? 0,
        legacyCoveredMessageIds: coveredMessageIds(latest.payload),
        legacyState,
        visibleEvents,
      });
      const retainedCount = retainedCompactionCount(latest.payload);
      const countDelta = Math.max(
        0,
        (legacyState.compactedMessageCount ?? retainedCount) - retainedCount,
      );
      await executor.execute(
        `WITH rewritten AS (
           SELECT
             event.ctid,
             jsonb_agg(
               (compaction.value - 'coveredMessageIds') ||
               jsonb_build_object(
                 'coveredMessageCount',
                 coalesce(
                   (compaction.value->>'coveredMessageCount')::integer,
                   jsonb_array_length(
                     coalesce(compaction.value->'coveredMessageIds', '[]'::jsonb)
                   )
                 ) + CASE
                   WHEN event.seq = $2 AND compaction.position = 1 THEN $4
                   ELSE 0
                 END
               )
               ORDER BY compaction.position
             ) AS compactions
           FROM junior_conversation_events event
           CROSS JOIN LATERAL jsonb_array_elements(
             event.payload->'compactions'
           ) WITH ORDINALITY AS compaction(value, position)
           WHERE event.conversation_id = $1
             AND event.type = 'messages_summarized'
           GROUP BY event.ctid
         )
         UPDATE junior_conversation_events event
         SET payload =
           (event.payload - 'compactions') ||
           jsonb_build_object('compactions', rewritten.compactions) ||
           CASE WHEN event.seq = $2
             THEN jsonb_build_object('historyFromSeq', $3::integer)
             ELSE '{}'::jsonb
           END
         FROM rewritten
         WHERE event.ctid = rewritten.ctid`,
        [conversationId, latest.seq, historyFromSeq, countDelta],
      );
    },
  );
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
        const compactionAnchor = await loadVisibleCompactionAnchor(
          executor,
          conversationId,
        );
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
             history_version,
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
               SELECT prior.history_version
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
                       'message',
                       'message_handled'
                     ) THEN coalesce((
                       SELECT max(-execution.seq - 1)
                       FROM junior_conversation_events execution
                       WHERE execution.conversation_id = event.conversation_id
                         AND execution.type NOT IN (
                           'message',
                           'message_handled'
                         )
                         AND execution.created_at < event.created_at
                     ), -1)
                     ELSE -event.seq - 1
                   END,
                   CASE
                     WHEN event.type IN (
                       'message',
                       'message_handled'
                     ) THEN 1
                     ELSE 0
                   END,
                   event.created_at,
                   CASE event.type
                     WHEN 'message' THEN 0
                     WHEN 'message_handled' THEN 1
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
        await normalizeVisibleCompactionBoundary(
          executor,
          conversationId,
          compactionAnchor,
        );
      });
    },
  );
}

/**
 * Copy canonical messages into the event log while retaining a recovery source.
 *
 * This must run after the external legacy-history import. A message event is
 * a completed-import seal, so running this from the schema migration
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
    const [legacyTable] = await executor.query<{ exists: boolean }>(
      `SELECT to_regclass('public.junior_conversation_messages') IS NOT NULL AS exists`,
    );
    if (!legacyTable?.exists) {
      return { existing: 0, migrated: 0, missing: 0, scanned: 0 };
    }
    const [before] = await executor.query<{ count: number }>(
      COUNT_MISSING_VISIBLE_EVENTS_SQL,
    );
    if (!before) {
      throw new Error(
        "Visible-message event migration could not inspect its projection",
      );
    }
    if (before.count > 0) {
      // This hard cut changes physical event positions. Drain resumable turns,
      // then invalidate terminal cursor records before any SQL sequence changes.
      const visibleConversationIds = new Set<string>();
      await visitVisibleConversations(
        executor,
        batchSize,
        async (conversationId) => {
          visibleConversationIds.add(conversationId);
        },
      );
      await prepareConversationEventResequence(context, visibleConversationIds);
    }
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
    await visitConversationIds(
      executor,
      LOAD_COMPACTED_CONVERSATION_IDS_SQL,
      batchSize,
      async (conversationId) =>
        await finalizeVisibleCompactions(context, executor, conversationId),
    );
    // TODO(v0.108.0): Drop the legacy message table after event-only writers
    // have been deployed for one release. Until then, rerunning this migration
    // recovers messages written by old workers during deployment.
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
  name: "move-conversation-messages-to-events",
  run: migrateConversationVisibleMessageEvents,
};
