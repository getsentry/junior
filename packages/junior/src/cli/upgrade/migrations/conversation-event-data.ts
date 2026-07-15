import { getChatConfig } from "@/chat/config";
import type { JuniorSqlExecutor } from "@/db/db";
import { createJuniorSqlExecutor } from "@/db/executor";
import type { MigrationContext, MigrationResult } from "../types";

const EVENT_DATA_BATCH_SIZE = 500;
const EVENT_DATA_REWRITE_LOCK = "junior:upgrade:conversation-event-data";

const REWRITE_EVENT_DATA_BATCH_SQL = `
WITH candidates AS MATERIALIZED (
  SELECT conversation_id, seq
  FROM junior_conversation_events
  WHERE type = 'pi_message'
    AND (
      $2::text IS NULL
      OR (conversation_id, seq) > ($2::text, $3::integer)
    )
  ORDER BY conversation_id, seq
  LIMIT $1
  FOR UPDATE SKIP LOCKED
), updated AS (
  UPDATE junior_conversation_events AS event
  SET
    schema_version = 1,
    type = 'message',
    payload = CASE
      WHEN jsonb_typeof(event.payload) = 'object'
        THEN event.payload - 'schemaVersion'
      ELSE event.payload
    END
  FROM candidates
  WHERE event.conversation_id = candidates.conversation_id
    AND event.seq = candidates.seq
  RETURNING event.conversation_id, event.seq
)
SELECT conversation_id, seq
FROM updated
ORDER BY conversation_id, seq
`;

const COUNT_LEGACY_EVENT_DATA_SQL = `
SELECT count(*)::integer AS count
FROM junior_conversation_events
WHERE type = 'pi_message'
`;

/** Rewrite legacy Pi message rows into canonical event data in bounded batches. */
export async function migrateConversationEventData(
  _context: MigrationContext,
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
    Math.floor(options.batchSize ?? EVENT_DATA_BATCH_SIZE),
  );
  let migrated = 0;
  let cursor: { conversationId: string; seq: number } | undefined;
  try {
    while (true) {
      const rows = await executor.withLock(EVENT_DATA_REWRITE_LOCK, () =>
        executor.query<{ conversation_id: string; seq: number }>(
          REWRITE_EVENT_DATA_BATCH_SQL,
          [batchSize, cursor?.conversationId ?? null, cursor?.seq ?? null],
        ),
      );
      migrated += rows.length;
      if (rows.length === 0) {
        break;
      }
      const last = rows.at(-1)!;
      cursor = { conversationId: last.conversation_id, seq: last.seq };
    }
    const [remaining] = await executor.query<{ count: number }>(
      COUNT_LEGACY_EVENT_DATA_SQL,
    );
    if (!remaining) {
      throw new Error(
        "Conversation event migration could not verify that all legacy rows were rewritten",
      );
    }
    if (remaining.count > 0) {
      throw new Error(
        `Conversation event migration left ${remaining.count} locked legacy row(s); rerun junior upgrade`,
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

export const conversationEventDataMigration = {
  name: "rewrite-conversation-event-data",
  run: migrateConversationEventData,
};
