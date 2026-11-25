import type { MigrationMeta } from "drizzle-orm/migrator";
import type { buildJuniorSqlConversation } from "./sql";

type SqlFixture = {
  sql: {
    execute: (query: string, params?: unknown[]) => Promise<unknown>;
  };
};

/**
 * Inbox item columns that the migrations keep for one release, for old
 * workers. The Drizzle schema no longer has them. Remove each name when its
 * follow-up migration drops the column.
 */
export const RETIRED_INBOX_ITEM_COLUMNS: readonly string[] = [
  // `20261125080100_inbox_item_subjects`
  "automation_id",
  "dedupe_key",
  "subject_title",
  "subject_title_parts",
  "subject_url",
  // `20261125090025_inbox_item_owners`
  "owner_id",
  "owner_kind",
  "provider",
  "provider_tenant_id",
  "visibility",
];

/** Apply a contiguous slice of packaged core migrations. */
export async function applyCoreMigrations(
  fixture: SqlFixture,
  coreMigrations: readonly MigrationMeta[],
  fromIndex: number,
  toIndexExclusive: number = coreMigrations.length,
): Promise<void> {
  for (const migration of coreMigrations.slice(fromIndex, toIndexExclusive)) {
    for (const statement of migration.sql) {
      await fixture.sql.execute(statement);
    }
  }
}

/** Insert one conversation row against a partial pre-actor_identity_id schema. */
export async function insertLegacyConversation(
  fixture: SqlFixture,
  conversation: ReturnType<typeof buildJuniorSqlConversation>,
): Promise<void> {
  await fixture.sql.execute(
    `INSERT INTO junior_conversations (
       conversation_id,
       source,
       destination_json,
       actor_json,
       channel_name,
       title,
       created_at,
       last_activity_at,
       updated_at,
       execution_status,
       root_conversation_id
     ) VALUES (
       $1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10, $11
     )`,
    [
      conversation.conversationId,
      conversation.source ?? null,
      JSON.stringify(conversation.destination ?? null),
      JSON.stringify(conversation.actor ?? null),
      conversation.channelName ?? null,
      conversation.title ?? null,
      conversation.createdAt,
      conversation.lastActivityAt,
      conversation.updatedAt,
      conversation.executionStatus,
      conversation.rootConversationId ?? conversation.conversationId,
    ],
  );
}

/** Insert one event row against a partial pre-actor_identity_id schema. */
export async function insertLegacyConversationEvent(
  fixture: SqlFixture,
  event: {
    conversationId: string;
    createdAt: Date;
    historyVersion: number;
    payload: Record<string, unknown>;
    seq: number;
    type: string;
  },
): Promise<void> {
  await fixture.sql.execute(
    `INSERT INTO junior_conversation_events (
       conversation_id,
       seq,
       history_version,
       schema_version,
       type,
       payload,
       created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6::jsonb, $7
     )`,
    [
      event.conversationId,
      event.seq,
      event.historyVersion,
      1,
      event.type,
      JSON.stringify(event.payload),
      event.createdAt,
    ],
  );
}
