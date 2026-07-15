import { getChatConfig } from "@/chat/config";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import type { ConversationMessageRole } from "@/chat/conversations/messages";
import type {
  ConversationEventStore,
  NewConversationEvent,
} from "@/chat/conversations/history";
import type { JuniorSqlExecutor } from "@/db/db";
import { createJuniorSqlExecutor } from "@/db/executor";
import type { MigrationContext, MigrationResult } from "../types";

const VISIBLE_EVENT_BATCH_SIZE = 500;
const VISIBLE_EVENT_BACKFILL_LOCK =
  "junior:upgrade:conversation-visible-message-events";

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

/** Backfill canonical visible-message events from the SQL read model. */
export async function migrateConversationVisibleMessageEvents(
  _context: MigrationContext,
  options: {
    batchSize?: number;
    eventStore?: Pick<ConversationEventStore, "append">;
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
      const store =
        options.eventStore ?? createSqlConversationEventStore(executor);
      for (const [conversationId, events] of grouped) {
        await store.append(conversationId, events);
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
