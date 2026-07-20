import { fileURLToPath } from "node:url";
import { getTableColumns, getTableName } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { JuniorSqlMigrationExecutor } from "@/db/db";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";
import { juniorSqlSchema as schema } from "@/db/schema";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { recordAgentTurnSessionSummary } from "@/chat/state/turn-session";
import {
  buildJuniorSqlConversation,
  createLocalJuniorSqlFixture,
} from "../fixtures/sql";
import {
  createEmptyJuniorSqlFixture,
  hasJuniorPostgresTestDatabase,
} from "../fixtures/postgres/fixture";

const coreMigrations = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
});
const legacyCoreMigrationChecksums = {
  "0001_conversation_core":
    "78fe050d8bec8ba18e2e3192497b3d8ad6b45fbb66ad4859377fb2202ed57651",
  "0002_slack_destination_visibility_backfill":
    "fb590a09fa51db471a748e3d7abb4137f521ee8df97f6e9ef5563121be98c394",
  "0003_user_identities":
    "67d9c9c26cbd76213614eb6d7a7cc7e2501fc20e92321eb5176a08ce39cd2efb",
  "0004_actor_cutover":
    "d41b8bfa66b8a88d69e84af38950025ba4c9be56341565cbe1411f0ca50c1dc2",
  "0005_conversation_transcripts":
    "add299d1b254e023f89b5993c417dd2248dc009e874efdeaf31ec0732e0d4fb4",
  "0006_conversation_metrics":
    "7c7ca5c9e11ed4b0e14737fd90d3348ea46e306c88fdf31199b7afb2a11c6a41",
} as const;

async function applyCoreMigration(
  executor: JuniorSqlMigrationExecutor,
  index: number,
  options: { statementLimit?: number } = {},
): Promise<void> {
  const migration = coreMigrations[index];
  if (!migration) {
    throw new Error(`Missing core migration at index ${index}`);
  }
  await executor.transaction(async () => {
    const statements =
      options.statementLimit === undefined
        ? migration.sql
        : migration.sql.slice(0, options.statementLimit);
    for (const statement of statements) {
      if (statement.trim()) await executor.execute(statement);
    }
  });
}

async function seedLegacyCoreSchema(
  executor: JuniorSqlMigrationExecutor,
  options: { metrics?: boolean } = {},
): Promise<void> {
  await applyCoreMigration(executor, 0);
  if (options.metrics) await applyCoreMigration(executor, 1);
}

async function recordLegacyCoreMigrations(
  executor: JuniorSqlMigrationExecutor,
  options: { metrics?: boolean } = {},
): Promise<void> {
  await executor.execute(`
CREATE TABLE junior_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`);
  const records = Object.entries(legacyCoreMigrationChecksums).filter(
    ([id]) => options.metrics || id !== "0006_conversation_metrics",
  );
  for (const [id, checksum] of records) {
    await executor.execute(
      "INSERT INTO junior_schema_migrations (id, checksum) VALUES ($1, $2)",
      [id, checksum],
    );
  }
}

async function expectNoDrizzleMigrationState(
  executor: JuniorSqlMigrationExecutor,
): Promise<void> {
  const [state] = await executor.query<{ schemaExists: boolean }>(`
SELECT EXISTS (
  SELECT 1
  FROM pg_namespace
  WHERE nspname = 'drizzle'
) AS "schemaExists"
`);
  expect(state?.schemaExists).toBe(false);
}

describe("conversation SQL local mode", () => {
  it("creates migrated tables matching the Drizzle schema", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);

      const rows = await fixture.sql.query<{
        column_name: string;
        table_name: string;
      }>(
        `
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name LIKE 'junior_%'
ORDER BY table_name ASC, ordinal_position ASC
`,
      );
      const actual = new Map<string, string[]>();
      for (const row of rows) {
        actual.set(row.table_name, [
          ...(actual.get(row.table_name) ?? []),
          row.column_name,
        ]);
      }
      const expected = new Map(
        Object.values(schema).map((table) => [
          getTableName(table),
          Object.values(getTableColumns(table))
            .map((column) => column.name)
            .sort(),
        ]),
      );

      for (const columns of actual.values()) columns.sort();

      // The core schema cut leaves this source table available for the
      // operator backfill; `junior upgrade` drops it after message events are
      // verified. It is intentionally absent from the target Drizzle schema.
      expect(actual.has("junior_conversation_messages")).toBe(true);
      actual.delete("junior_conversation_messages");
      expect(actual).toEqual(expected);
      expect(actual.has("junior_conversation_inbound_messages")).toBe(false);

      const indexRows = await fixture.sql.query<{ indexname: string }>(
        `
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE 'junior_%'
ORDER BY indexname ASC
`,
      );
      const indexNames = indexRows.map((row) => row.indexname);
      expect(indexNames).toEqual(
        expect.arrayContaining([
          "junior_conversations_active_idx",
          "junior_conversations_actor_activity_idx",
          "junior_conversations_destination_activity_idx",
          "junior_conversations_last_activity_idx",
          "junior_conversations_origin_idx",
          "junior_conversations_pkey",
          "junior_conversations_actor_activity_idx",
          "junior_conversation_messages_search_idx",
          "junior_conversation_events_message_search_idx",
          "junior_destinations_pkey",
          "junior_destinations_provider_destination_uidx",
          "junior_identities_kind_provider_idx",
          "junior_identities_pkey",
          "junior_identities_provider_subject_uidx",
          "junior_identities_user_idx",
          "junior_identities_verified_email_idx",
          "junior_users_pkey",
          "junior_users_primary_email_normalized_uidx",
        ]),
      );

      const constraintRows = await fixture.sql.query<{
        constraint_name: string;
        constraint_type: string;
        table_name: string;
      }>(
        `
SELECT table_name, constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_schema = 'public'
  AND table_name LIKE 'junior_%'
ORDER BY table_name ASC, constraint_name ASC
`,
      );
      expect(constraintRows).toEqual(
        expect.arrayContaining([
          {
            table_name: "junior_conversations",
            constraint_name: "junior_conversations_pkey",
            constraint_type: "PRIMARY KEY",
          },
        ]),
      );
      expect(
        constraintRows.some(
          (row) => row.table_name === "junior_conversation_inbound_messages",
        ),
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it("keeps core migrations separate from another Drizzle journal", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await fixture.sql.execute("CREATE SCHEMA IF NOT EXISTS drizzle");
      await fixture.sql.execute(`
CREATE TABLE drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT
)
`);
      await fixture.sql.execute(`
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('host-migration', 9999999999999)
`);

      await migrateSchema(fixture.sql);

      const [host] = await fixture.sql.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
      );
      const [core] = await fixture.sql.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM drizzle.__drizzle_junior_core",
      );
      expect(host?.count).toBe(1);
      expect(core?.count).toBe(coreMigrations.length);
    } finally {
      await fixture.close();
    }
  });

  it.skipIf(!hasJuniorPostgresTestDatabase())(
    "serializes concurrent legacy adoption and core migrations",
    async () => {
      const fixture = await createEmptyJuniorSqlFixture();
      const second = createPostgresJuniorSqlExecutor({
        connectionString: fixture.connectionString,
      });

      try {
        await seedLegacyCoreSchema(fixture.sql);
        await recordLegacyCoreMigrations(fixture.sql);
        await Promise.all([
          fixture.sql.query("SELECT 1"),
          second.query("SELECT 1"),
        ]);

        await Promise.all([migrateSchema(fixture.sql), migrateSchema(second)]);
        const [journal] = await fixture.sql.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM drizzle.__drizzle_junior_core",
        );
        expect(journal?.count).toBe(coreMigrations.length);
      } finally {
        await second.close();
        await fixture.close();
      }
    },
  );

  it("runs migrations and stores metadata through the Drizzle schema", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await migrateSchema(fixture.sql);

      const conversation = buildJuniorSqlConversation({
        conversationId: "slack:C123:1718123456.000000",
      });

      await fixture.sql.execute(
        `
INSERT INTO junior_conversations (
  conversation_id,
  source,
  destination_json,
  actor_json,
  channel_name,
  title,
  created_at,
  last_activity_at,
  updated_at,
  execution_status
) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10)
`,
        [
          conversation.conversationId,
          conversation.source,
          JSON.stringify(conversation.destination),
          JSON.stringify(conversation.actor),
          conversation.channelName,
          conversation.title,
          conversation.createdAt.toISOString(),
          conversation.lastActivityAt.toISOString(),
          conversation.updatedAt.toISOString(),
          conversation.executionStatus,
        ],
      );

      const rows = await fixture.sql.query<{
        channel_name: string;
        conversation_id: string;
        destination_json: unknown;
        execution_status: string;
        actor_json: unknown;
        source: string;
        title: string;
      }>(
        `
SELECT conversation_id, source, destination_json, actor_json, channel_name, title, execution_status
FROM junior_conversations
WHERE conversation_id = $1
`,
        ["slack:C123:1718123456.000000"],
      );
      const [migrationRows] = await fixture.sql.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM drizzle.__drizzle_junior_core",
      );

      expect(migrationRows?.count).toBe(coreMigrations.length);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        conversation_id: "slack:C123:1718123456.000000",
        source: "slack",
        channel_name: "eng-runtime",
        title: "Metadata migration test",
        execution_status: "idle",
        destination_json: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
        actor_json: {
          platform: "slack",
          slackUserId: "U123",
          teamId: "T123",
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("adopts a deployed pre-Drizzle schema before applying new migrations", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await seedLegacyCoreSchema(fixture.sql);
      await recordLegacyCoreMigrations(fixture.sql);

      await migrateSchema(fixture.sql);

      const metricColumns = await fixture.sql.query<{ column_name: string }>(`
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'junior_conversations'
  AND column_name IN (
    'duration_ms',
    'usage_json',
    'execution_duration_ms',
    'execution_usage_json'
  )
ORDER BY column_name
`);
      const [migrationRows] = await fixture.sql.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM drizzle.__drizzle_junior_core",
      );

      expect(metricColumns.map((row) => row.column_name)).toEqual([
        "duration_ms",
        "execution_duration_ms",
        "execution_usage_json",
        "usage_json",
      ]);
      expect(migrationRows?.count).toBe(coreMigrations.length);
    } finally {
      await fixture.close();
    }
  });

  it("ignores unrelated records in the shared legacy migration journal", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await seedLegacyCoreSchema(fixture.sql);
      await recordLegacyCoreMigrations(fixture.sql);
      await fixture.sql.execute(
        "INSERT INTO junior_schema_migrations (id, checksum) VALUES ('plugin:example:0001', 'plugin-checksum')",
      );

      await migrateSchema(fixture.sql);

      const [migrationRows] = await fixture.sql.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM drizzle.__drizzle_junior_core",
      );
      expect(migrationRows?.count).toBe(coreMigrations.length);
    } finally {
      await fixture.close();
    }
  });

  it("adopts a fully migrated legacy schema without replaying metrics", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await seedLegacyCoreSchema(fixture.sql, { metrics: true });
      await recordLegacyCoreMigrations(fixture.sql, { metrics: true });

      await migrateSchema(fixture.sql);

      const [migrationRows] = await fixture.sql.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM drizzle.__drizzle_junior_core",
      );
      const [searchIndex] = await fixture.sql.query<{ exists: boolean }>(`
SELECT to_regclass('public.junior_conversation_messages_search_idx') IS NOT NULL AS exists
`);
      const metricColumns = await fixture.sql.query<{ column_name: string }>(`
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'junior_conversations'
  AND column_name IN (
    'duration_ms',
    'usage_json',
    'execution_duration_ms',
    'execution_usage_json'
  )
ORDER BY column_name
`);
      expect(migrationRows?.count).toBe(coreMigrations.length - 1);
      expect(searchIndex?.exists).toBe(true);
      expect(metricColumns.map((row) => row.column_name)).toEqual([
        "duration_ms",
        "execution_duration_ms",
        "execution_usage_json",
        "usage_json",
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects legacy adoption after the event-table cutover", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      await recordLegacyCoreMigrations(fixture.sql, { metrics: true });
      await fixture.sql.execute("DROP SCHEMA drizzle CASCADE");

      await expect(migrateSchema(fixture.sql)).rejects.toThrow(
        "Cannot adopt legacy core migration state: expected the pre-Drizzle junior_agent_steps table and no junior_conversation_events table",
      );
      await expectNoDrizzleMigrationState(fixture.sql);
    } finally {
      await fixture.close();
    }
  });

  it("rejects partially applied legacy metric columns without mutation", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await seedLegacyCoreSchema(fixture.sql);
      await applyCoreMigration(fixture.sql, 1, { statementLimit: 1 });
      await recordLegacyCoreMigrations(fixture.sql);

      await expect(migrateSchema(fixture.sql)).rejects.toThrow(
        "Cannot adopt partial legacy metrics state: found 1 of 4 required columns",
      );
      await expectNoDrizzleMigrationState(fixture.sql);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a legacy metrics record without metric columns", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await seedLegacyCoreSchema(fixture.sql);
      await recordLegacyCoreMigrations(fixture.sql, { metrics: true });

      await expect(migrateSchema(fixture.sql)).rejects.toThrow(
        "Cannot adopt legacy core migration state: legacy metrics migration record does not match physical metric columns",
      );
      await expectNoDrizzleMigrationState(fixture.sql);
    } finally {
      await fixture.close();
    }
  });

  it("rejects complete metric columns without a legacy metrics record", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await seedLegacyCoreSchema(fixture.sql, { metrics: true });
      await recordLegacyCoreMigrations(fixture.sql);

      await expect(migrateSchema(fixture.sql)).rejects.toThrow(
        "Cannot adopt legacy core migration state: legacy metrics migration record does not match physical metric columns",
      );
      await expectNoDrizzleMigrationState(fixture.sql);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a changed legacy core checksum without mutation", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await seedLegacyCoreSchema(fixture.sql);
      await recordLegacyCoreMigrations(fixture.sql);
      await fixture.sql.execute(
        "UPDATE junior_schema_migrations SET checksum = 'changed' WHERE id = '0003_user_identities'",
      );

      await expect(migrateSchema(fixture.sql)).rejects.toThrow(
        "Cannot adopt legacy core migration state: checksum mismatch: 0003_user_identities",
      );
      await expectNoDrizzleMigrationState(fixture.sql);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a changed legacy metrics checksum without mutation", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await seedLegacyCoreSchema(fixture.sql, { metrics: true });
      await recordLegacyCoreMigrations(fixture.sql, { metrics: true });
      await fixture.sql.execute(
        "UPDATE junior_schema_migrations SET checksum = 'changed' WHERE id = '0006_conversation_metrics'",
      );

      await expect(migrateSchema(fixture.sql)).rejects.toThrow(
        "Cannot adopt legacy core migration state: checksum mismatch: 0006_conversation_metrics",
      );
      await expectNoDrizzleMigrationState(fixture.sql);
    } finally {
      await fixture.close();
    }
  });

  it("rejects legacy adoption after immutable migration 0002 ran", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await seedLegacyCoreSchema(fixture.sql, { metrics: true });
      await applyCoreMigration(fixture.sql, 2);
      await recordLegacyCoreMigrations(fixture.sql, { metrics: true });

      await expect(migrateSchema(fixture.sql)).rejects.toThrow(
        "Cannot adopt legacy core migration state: post-baseline schema markers are already present: junior_conversation_messages_search_idx",
      );
      await expectNoDrizzleMigrationState(fixture.sql);
    } finally {
      await fixture.close();
    }
  });

  it("rejects legacy adoption after immutable migration 0003 ran", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await seedLegacyCoreSchema(fixture.sql, { metrics: true });
      await applyCoreMigration(fixture.sql, 2);
      await applyCoreMigration(fixture.sql, 3);
      await recordLegacyCoreMigrations(fixture.sql, { metrics: true });

      await expect(migrateSchema(fixture.sql)).rejects.toThrow(
        "Cannot adopt legacy core migration state: post-baseline schema markers are already present: junior_conversation_messages_search_idx, junior_conversations.metric_run_id",
      );
      await expectNoDrizzleMigrationState(fixture.sql);
    } finally {
      await fixture.close();
    }
  });

  it("rejects partial pre-Drizzle core migration state", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await fixture.sql.execute(`
CREATE TABLE junior_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`);
      await fixture.sql.execute(`
INSERT INTO junior_schema_migrations (id, checksum)
VALUES (
  '0001_conversation_core',
  '78fe050d8bec8ba18e2e3192497b3d8ad6b45fbb66ad4859377fb2202ed57651'
)
`);

      await expect(migrateSchema(fixture.sql)).rejects.toThrow(
        "Cannot adopt partial legacy core migration state",
      );
      await expectNoDrizzleMigrationState(fixture.sql);
    } finally {
      await fixture.close();
    }
  });

  it("mirrors completed scheduler turns into SQL conversation record", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);

      await recordAgentTurnSessionSummary({
        conversationId: "agent-dispatch:dispatch_scheduler_run",
        cumulativeDurationMs: 2400,
        cumulativeUsage: {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 5,
          cost: { total: 0.003 },
        },
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        sessionId: "dispatch:scheduler-run",
        sliceId: 1,
        state: "completed",
        conversationStore: store,
        surface: "scheduler",
      });
      await recordAgentTurnSessionSummary({
        conversationId: "agent-dispatch:dispatch_scheduler_run",
        cumulativeDurationMs: 2_600,
        sessionId: "dispatch:scheduler-run",
        sliceId: 2,
        state: "running",
        conversationStore: store,
        surface: "scheduler",
      });
      await recordAgentTurnSessionSummary({
        conversationId: "agent-dispatch:dispatch_scheduler_run",
        cumulativeDurationMs: 3_000,
        cumulativeUsage: {
          inputTokens: 150,
          outputTokens: 30,
          reasoningTokens: 7,
          cost: { total: 0.004 },
        },
        sessionId: "dispatch:scheduler-run",
        sliceId: 2,
        state: "completed",
        conversationStore: store,
        surface: "scheduler",
      });
      const beforeNextTurn = await store.get({
        conversationId: "agent-dispatch:dispatch_scheduler_run",
      });
      await store.recordExecution({
        conversationId: "agent-dispatch:dispatch_scheduler_run",
        createdAtMs: beforeNextTurn!.createdAtMs,
        execution: {
          runId: "dispatch:scheduler-run-2",
          status: "running",
          updatedAtMs: Date.now(),
        },
        lastActivityAtMs: Date.now(),
        metrics: null,
        source: "scheduler",
        updatedAtMs: Date.now(),
      });
      await recordAgentTurnSessionSummary({
        conversationId: "agent-dispatch:dispatch_scheduler_run",
        cumulativeDurationMs: 500,
        cumulativeUsage: {
          totalTokens: 25,
          reasoningTokens: 2,
          cost: { total: 0.0015 },
        },
        sessionId: "dispatch:scheduler-run-2",
        sliceId: 1,
        state: "completed",
        conversationStore: store,
        surface: "scheduler",
      });

      await expect(
        store.get({
          conversationId: "agent-dispatch:dispatch_scheduler_run",
        }),
      ).resolves.toMatchObject({
        conversationId: "agent-dispatch:dispatch_scheduler_run",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        execution: {
          runId: "dispatch:scheduler-run-2",
          status: "idle",
        },
        source: "scheduler",
      });
      const [metrics] = await fixture.sql.query<{
        durationMs: number;
        usage: {
          cost?: { total?: number };
          reasoningTokens?: number;
          totalTokens?: number;
        } | null;
      }>(`
SELECT
  duration_ms::integer AS "durationMs",
  usage_json AS usage
FROM junior_conversations
WHERE conversation_id = 'agent-dispatch:dispatch_scheduler_run'
`);
      expect(metrics).toMatchObject({
        durationMs: 3_500,
        usage: {
          cost: { total: 0.0055 },
          reasoningTokens: 9,
          totalTokens: 205,
        },
      });
    } finally {
      await disconnectStateAdapter();
      await fixture.close();
    }
  });
});
