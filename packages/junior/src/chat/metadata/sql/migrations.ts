import { createHash } from "node:crypto";
import { z } from "zod";
import { schema } from "./schema";
import type { JuniorSqlMigrationExecutor } from "@/chat/sql/db";

const MIGRATION_LOCK_NAME = "junior_conversation_metadata_schema";

const migrationRecordSchema = z
  .object({
    id: z.string().min(1),
    checksum: z.string().min(1),
  })
  .strict();

export interface Migration {
  checksum: string;
  id: string;
  statements: readonly string[];
}

interface StoredMigrationRecord {
  checksum: string;
  id: string;
}

function checksumStatements(statements: readonly string[]): string {
  const hash = createHash("sha256");
  for (const statement of statements) {
    hash.update(statement);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function defineMigration(id: string, statements: readonly string[]): Migration {
  return {
    id,
    checksum: checksumStatements(statements),
    statements,
  };
}

const createMigrationTable = `
CREATE TABLE IF NOT EXISTS junior_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`;

const coreMetadataStatements = [
  `
CREATE TABLE IF NOT EXISTS junior_identities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_tenant_id TEXT NOT NULL DEFAULT '',
  provider_subject_id TEXT NOT NULL,
  display_name TEXT,
  handle TEXT,
  email TEXT,
  avatar_url TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
)
`,
  `
CREATE UNIQUE INDEX IF NOT EXISTS junior_identities_provider_subject_uidx
  ON junior_identities (provider, provider_tenant_id, provider_subject_id)
`,
  `
CREATE INDEX IF NOT EXISTS junior_identities_kind_provider_idx
  ON junior_identities (kind, provider)
`,
  `
CREATE TABLE IF NOT EXISTS junior_destinations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_tenant_id TEXT NOT NULL DEFAULT '',
  provider_destination_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_destination_id TEXT,
  display_name TEXT,
  visibility TEXT NOT NULL DEFAULT 'unknown',
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
)
`,
  `
CREATE UNIQUE INDEX IF NOT EXISTS junior_destinations_provider_destination_uidx
  ON junior_destinations (provider, provider_tenant_id, provider_destination_id)
`,
  `
CREATE INDEX IF NOT EXISTS junior_destinations_provider_kind_idx
  ON junior_destinations (provider, kind)
`,
  `
CREATE TABLE IF NOT EXISTS junior_conversations (
  conversation_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  source TEXT,
  origin_type TEXT,
  origin_id TEXT,
  origin_run_id TEXT,
  destination_id TEXT REFERENCES junior_destinations (id),
  destination_json JSONB,
  actor_identity_id TEXT REFERENCES junior_identities (id),
  requester_identity_id TEXT REFERENCES junior_identities (id),
  creator_identity_id TEXT REFERENCES junior_identities (id),
  credential_subject_identity_id TEXT REFERENCES junior_identities (id),
  requester_json JSONB,
  channel_name TEXT,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  execution_updated_at TIMESTAMPTZ,
  execution_status TEXT NOT NULL,
  run_id TEXT,
  last_checkpoint_at TIMESTAMPTZ,
  last_enqueued_at TIMESTAMPTZ,
  lease_token TEXT,
  lease_acquired_at TIMESTAMPTZ,
  lease_last_check_in_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ
)
`,
  `
CREATE INDEX IF NOT EXISTS junior_conversations_last_activity_idx
  ON junior_conversations (last_activity_at DESC, conversation_id)
`,
  `
CREATE INDEX IF NOT EXISTS junior_conversations_active_idx
  ON junior_conversations (coalesce(execution_updated_at, updated_at) ASC, conversation_id)
  WHERE execution_status <> 'idle'
`,
  `
CREATE INDEX IF NOT EXISTS junior_conversations_destination_activity_idx
  ON junior_conversations (destination_id, last_activity_at DESC)
`,
  `
CREATE INDEX IF NOT EXISTS junior_conversations_actor_activity_idx
  ON junior_conversations (actor_identity_id, last_activity_at DESC)
`,
  `
CREATE INDEX IF NOT EXISTS junior_conversations_requester_activity_idx
  ON junior_conversations (requester_identity_id, last_activity_at DESC)
`,
  `
CREATE INDEX IF NOT EXISTS junior_conversations_origin_idx
  ON junior_conversations (origin_type, origin_id, last_activity_at DESC)
`,
  `
CREATE TABLE IF NOT EXISTS junior_conversation_inbound_messages (
  conversation_id TEXT NOT NULL REFERENCES junior_conversations (conversation_id) ON DELETE CASCADE,
  inbound_message_id TEXT NOT NULL,
  source TEXT NOT NULL,
  destination_id TEXT NOT NULL REFERENCES junior_destinations (id),
  destination_json JSONB NOT NULL,
  input_json JSONB,
  input_text_length INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  injected_at TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, inbound_message_id)
)
`,
  `
CREATE INDEX IF NOT EXISTS junior_conversation_inbound_pending_idx
  ON junior_conversation_inbound_messages (conversation_id, created_at, received_at, inbound_message_id)
  WHERE injected_at IS NULL
`,
] as const;

export const migrations = [
  defineMigration("0001_conversation_metadata_core", coreMetadataStatements),
] as const;

export { schema };

function parseStoredMigrationRecord(value: unknown): StoredMigrationRecord {
  return migrationRecordSchema.parse(value);
}

async function listAppliedMigrations(
  executor: JuniorSqlMigrationExecutor,
): Promise<Map<string, StoredMigrationRecord>> {
  const rows = await executor.query(
    "SELECT id, checksum FROM junior_schema_migrations ORDER BY id ASC",
  );
  const records = new Map<string, StoredMigrationRecord>();
  for (const row of rows) {
    const record = parseStoredMigrationRecord(row);
    records.set(record.id, record);
  }
  return records;
}

async function applyMigration(
  executor: JuniorSqlMigrationExecutor,
  migration: Migration,
): Promise<void> {
  await executor.transaction(async () => {
    for (const statement of migration.statements) {
      await executor.execute(statement);
    }
    await executor.execute(
      "INSERT INTO junior_schema_migrations (id, checksum) VALUES ($1, $2)",
      [migration.id, migration.checksum],
    );
  });
}

/** Apply pending SQL schema migrations for queryable conversation metadata. */
export async function migrateSchema(
  executor: JuniorSqlMigrationExecutor,
  migrationList: readonly Migration[] = migrations,
): Promise<void> {
  await executor.withLock(MIGRATION_LOCK_NAME, async () => {
    await executor.execute(createMigrationTable);
    const applied = await listAppliedMigrations(executor);
    for (const migration of migrationList) {
      const existing = applied.get(migration.id);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(
            `Conversation metadata migration ${migration.id} checksum changed`,
          );
        }
        continue;
      }
      await applyMigration(executor, migration);
    }
  });
}
