import { fileURLToPath } from "node:url";
import { eq, getTableColumns, getTableName } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it, vi } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { JuniorSqlMigrationExecutor } from "@/db/db";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";
import {
  juniorConversationEvents,
  juniorSqlSchema as schema,
} from "@/db/schema";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { recordAgentTurnSessionSummary } from "@/chat/task-execution/turn-cursor";
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
  it("backfills session sources from matching conversation destinations", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const sourceMigrationIndex = coreMigrations.findIndex((migration) =>
      migration.sql.some((statement) =>
        statement.includes('ADD COLUMN "source_json" jsonb'),
      ),
    );
    const sourceMigration = coreMigrations[sourceMigrationIndex];
    if (!sourceMigration) {
      throw new Error("Conversation session source migration not found");
    }
    const visibilityMigration = coreMigrations[sourceMigrationIndex + 1];
    if (
      !visibilityMigration?.sql.some((statement) =>
        statement.includes("jsonb_build_object(\n  'visibility'"),
      )
    ) {
      throw new Error("Conversation source visibility migration not found");
    }

    try {
      for (const migration of coreMigrations.slice(0, sourceMigrationIndex)) {
        for (const statement of migration.sql) {
          await fixture.sql.execute(statement);
        }
      }
      await fixture.sql.execute(`
INSERT INTO junior_destinations (
  id,
  provider,
  provider_tenant_id,
  provider_destination_id,
  kind,
  visibility,
  created_at,
  updated_at
) VALUES
  ('slack-public', 'slack', 'T123', 'C123', 'channel', 'public', to_timestamp(1), to_timestamp(1)),
  ('slack-unknown', 'slack', 'T123', 'C456', 'channel', 'unknown', to_timestamp(1), to_timestamp(1)),
  ('slack-private', 'slack', 'T123', 'G123', 'group', 'unknown', to_timestamp(1), to_timestamp(1)),
  ('local', 'local', '', 'local:test:session', 'local_conversation', 'private', to_timestamp(1), to_timestamp(1))
`);
      await fixture.sql.execute(`
INSERT INTO junior_conversations (
  conversation_id,
  destination_id,
  created_at,
  last_activity_at,
  updated_at,
  execution_status
) VALUES
  ('slack:C123:1700000000.001', 'slack-public', to_timestamp(1), to_timestamp(1), to_timestamp(1), 'idle'),
  ('slack:C456:1700000000.002', 'slack-unknown', to_timestamp(1), to_timestamp(1), to_timestamp(1), 'idle'),
  ('slack:G123:1700000000.003', 'slack-private', to_timestamp(1), to_timestamp(1), to_timestamp(1), 'idle'),
  ('slack:C999:1700000000.004', 'slack-public', to_timestamp(1), to_timestamp(1), to_timestamp(1), 'idle'),
  ('local:test:session', 'local', to_timestamp(1), to_timestamp(1), to_timestamp(1), 'idle')
`);

      for (const statement of sourceMigration.sql) {
        await fixture.sql.execute(statement);
      }
      for (const statement of visibilityMigration.sql) {
        await fixture.sql.execute(statement);
      }

      const rows = await fixture.sql.query<{
        conversationId: string;
        sessionSource: unknown;
      }>(`
SELECT
  conversation_id AS "conversationId",
  source_json AS "sessionSource"
FROM junior_conversations
ORDER BY conversation_id
`);
      expect(
        Object.fromEntries(
          rows.map((row) => [row.conversationId, row.sessionSource]),
        ),
      ).toEqual({
        "local:test:session": {
          platform: "local",
          visibility: "private",
          conversationId: "local:test:session",
        },
        "slack:C123:1700000000.001": {
          platform: "slack",
          visibility: "public",
          teamId: "T123",
          channelId: "C123",
          threadTs: "1700000000.001",
        },
        "slack:C456:1700000000.002": null,
        "slack:C999:1700000000.004": null,
        "slack:G123:1700000000.003": {
          platform: "slack",
          visibility: "private",
          teamId: "T123",
          channelId: "G123",
          threadTs: "1700000000.003",
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("migrates legacy agent history to native event types", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const nativeHistoryMigrationIndex = coreMigrations.findIndex((migration) =>
      migration.sql.some((statement) =>
        statement.includes(
          "Cannot migrate malformed agent_step conversation events",
        ),
      ),
    );
    const nativeHistoryMigration = coreMigrations[nativeHistoryMigrationIndex];
    if (!nativeHistoryMigration) {
      throw new Error("Native conversation history migration not found");
    }

    try {
      for (const migration of coreMigrations.slice(
        0,
        nativeHistoryMigrationIndex,
      )) {
        for (const statement of migration.sql) {
          await fixture.sql.execute(statement);
        }
      }

      const conversationId = "internal:native-history-migration";
      // Insert with the pre-source_json column set so this fixture stays valid
      // against the partial migration history applied above.
      const conversation = buildJuniorSqlConversation({ conversationId });
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
      await fixture.sql
        .db()
        .insert(juniorConversationEvents)
        .values([
          {
            conversationId,
            seq: 0,
            historyVersion: 0,
            schemaVersion: 1,
            type: "agent_step",
            payload: {
              message: {
                role: "user",
                content: "Investigate the failure",
                timestamp: 1_000,
              },
            },
            createdAt: new Date(1_000),
          },
          {
            conversationId,
            seq: 1,
            historyVersion: 0,
            schemaVersion: 1,
            type: "agent_step",
            payload: {
              message: {
                role: "assistant",
                content: [],
                api: "responses",
                provider: "openai",
                model: "gpt-5.4",
                usage: {},
                stopReason: "toolUse",
                timestamp: 1_001,
              },
            },
            createdAt: new Date(1_001),
          },
          {
            conversationId,
            seq: 2,
            historyVersion: 0,
            schemaVersion: 1,
            type: "agent_step",
            payload: {
              message: {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "search",
                content: [],
                isError: false,
                timestamp: 1_002,
              },
            },
            createdAt: new Date(1_002),
          },
          {
            conversationId,
            seq: 3,
            historyVersion: 1,
            schemaVersion: 1,
            type: "rollback",
            payload: {
              modelProfile: "coding",
              modelId: "openai/gpt-5.4",
              replacementHistory: [
                {
                  message: {
                    role: "user",
                    type: "tool_result",
                    content: "Retained instruction",
                    timestamp: 1_000,
                  },
                  provenance: { authority: "instruction" },
                  sourceEventSeq: 0,
                },
              ],
            },
            createdAt: new Date(1_003),
          },
        ]);

      for (const statement of nativeHistoryMigration.sql) {
        await fixture.sql.execute(statement);
      }
      // The transformation is safe if an operator reruns its SQL manually.
      for (const statement of nativeHistoryMigration.sql) {
        await fixture.sql.execute(statement);
      }

      const rows = await fixture.sql
        .db()
        .select({
          type: juniorConversationEvents.type,
          payload: juniorConversationEvents.payload,
        })
        .from(juniorConversationEvents)
        .orderBy(juniorConversationEvents.seq);

      expect(rows).toEqual([
        {
          type: "user_message",
          payload: {
            content: "Investigate the failure",
            provenance: { authority: "context" },
            timestamp: 1_000,
          },
        },
        {
          type: "assistant_message",
          payload: {
            api: "responses",
            content: [],
            model: "gpt-5.4",
            provider: "openai",
            stopReason: "toolUse",
            timestamp: 1_001,
            usage: {},
          },
        },
        {
          type: "tool_result",
          payload: {
            content: [],
            isError: false,
            timestamp: 1_002,
            toolCallId: "call-1",
            toolName: "search",
          },
        },
        {
          type: "compaction",
          payload: {
            modelId: "openai/gpt-5.4",
            modelProfile: "coding",
            replacementHistory: [
              {
                item: {
                  content: "Retained instruction",
                  provenance: { authority: "instruction" },
                  timestamp: 1_000,
                  type: "user_message",
                },
                sourceEventSeq: 0,
              },
            ],
          },
        },
      ]);

      await fixture.sql
        .db()
        .insert(juniorConversationEvents)
        .values({
          conversationId,
          seq: 4,
          historyVersion: 1,
          schemaVersion: 1,
          type: "agent_step",
          payload: { message: { role: "system" } },
          createdAt: new Date(1_004),
        });
      await expect(
        (async () => {
          for (const statement of nativeHistoryMigration.sql) {
            await fixture.sql.execute(statement);
          }
        })(),
      ).rejects.toThrow("Cannot migrate malformed agent_step");
      const [malformed] = await fixture.sql
        .db()
        .select({
          type: juniorConversationEvents.type,
          payload: juniorConversationEvents.payload,
        })
        .from(juniorConversationEvents)
        .where(eq(juniorConversationEvents.seq, 4));
      expect(malformed).toEqual({
        type: "agent_step",
        payload: { message: { role: "system" } },
      });

      await fixture.sql
        .db()
        .delete(juniorConversationEvents)
        .where(eq(juniorConversationEvents.seq, 4));
      await fixture.sql
        .db()
        .insert(juniorConversationEvents)
        .values({
          conversationId,
          seq: 4,
          historyVersion: 1,
          schemaVersion: 1,
          type: "compaction",
          payload: {
            modelProfile: "standard",
            modelId: "openai/gpt-5.4",
            replacementHistory: [{}],
          },
          createdAt: new Date(1_004),
        });
      await expect(
        (async () => {
          for (const statement of nativeHistoryMigration.sql) {
            await fixture.sql.execute(statement);
          }
        })(),
      ).rejects.toThrow("Cannot migrate malformed replacement history items");
      const [malformedReplacement] = await fixture.sql
        .db()
        .select({
          type: juniorConversationEvents.type,
          payload: juniorConversationEvents.payload,
        })
        .from(juniorConversationEvents)
        .where(eq(juniorConversationEvents.seq, 4));
      expect(malformedReplacement).toEqual({
        type: "compaction",
        payload: {
          modelProfile: "standard",
          modelId: "openai/gpt-5.4",
          replacementHistory: [{}],
        },
      });
    } finally {
      await fixture.close();
    }
  });

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
          "junior_conversations_root_idx",
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

  it("backfills the owning root for existing conversation trees", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await fixture.sql.execute(`
CREATE TABLE junior_conversations (
  conversation_id text PRIMARY KEY,
  parent_conversation_id text,
  created_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  execution_status text NOT NULL
)
`);
      await fixture.sql.execute(`
INSERT INTO junior_conversations (
  conversation_id,
  parent_conversation_id,
  created_at,
  last_activity_at,
  updated_at,
  execution_status
) VALUES
  ('root', NULL, now(), now(), now(), 'idle'),
  ('child', 'root', now(), now(), now(), 'idle'),
  ('grandchild', 'child', now(), now(), now(), 'idle'),
  ('cycle-a', NULL, now(), now(), now(), 'idle'),
  ('cycle-b', 'cycle-a', now(), now(), now(), 'idle')
`);
      await fixture.sql.execute(
        "UPDATE junior_conversations SET parent_conversation_id = 'cycle-b' WHERE conversation_id = 'cycle-a'",
      );

      const rootMigration = coreMigrations.find((migration) =>
        migration.sql.some((statement) =>
          statement.includes('ADD COLUMN "root_conversation_id"'),
        ),
      );
      if (!rootMigration) throw new Error("Root migration not found");
      for (const statement of rootMigration.sql) {
        await fixture.sql.execute(statement);
      }

      const rows = await fixture.sql.query<{
        conversationId: string;
        rootConversationId: string | null;
      }>(`
SELECT
  conversation_id AS "conversationId",
  root_conversation_id AS "rootConversationId"
FROM junior_conversations
ORDER BY conversation_id
`);
      expect(rows).toEqual([
        { conversationId: "child", rootConversationId: "root" },
        { conversationId: "cycle-a", rootConversationId: null },
        { conversationId: "cycle-b", rootConversationId: null },
        { conversationId: "grandchild", rootConversationId: "root" },
        { conversationId: "root", rootConversationId: "root" },
      ]);
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
    "cancels runtime queries after the configured statement timeout",
    async () => {
      const fixture = await createEmptyJuniorSqlFixture();
      const executor = createPostgresJuniorSqlExecutor({
        connectionString: fixture.connectionString,
        statementTimeoutMs: 10,
      });

      try {
        await expect(
          executor.query("SELECT pg_sleep(0.05)"),
        ).rejects.toMatchObject({ code: "57014" });
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
  );

  it.skipIf(!hasJuniorPostgresTestDatabase())(
    "serializes concurrent core migrations",
    async () => {
      const fixture = await createEmptyJuniorSqlFixture();
      const second = createPostgresJuniorSqlExecutor({
        connectionString: fixture.connectionString,
      });

      try {
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
      const migrationLock = vi.spyOn(fixture.sql, "withMigrationLock");
      await expect(migrateSchema(fixture.sql)).resolves.toEqual({
        existing: 0,
        migrated: coreMigrations.length,
        scanned: coreMigrations.length,
      });
      expect(migrationLock).toHaveBeenCalledOnce();

      migrationLock.mockClear();
      await expect(migrateSchema(fixture.sql)).resolves.toEqual({
        existing: coreMigrations.length,
        migrated: 0,
        scanned: coreMigrations.length,
      });
      expect(migrationLock).not.toHaveBeenCalled();

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

  it.skipIf(!hasJuniorPostgresTestDatabase())(
    "requires the bridge release for existing pre-Drizzle tables",
    async () => {
      const fixture = await createEmptyJuniorSqlFixture();

      try {
        await fixture.sql.execute(`
CREATE TABLE junior_conversations (
  conversation_id TEXT PRIMARY KEY
)
`);

        await expect(migrateSchema(fixture.sql)).rejects.toThrow(
          "Stop old Junior workers, install @sentry/junior@0.107.1, run `junior upgrade`, then restore this Junior version",
        );
        await expectNoDrizzleMigrationState(fixture.sql);
      } finally {
        await fixture.close();
      }
    },
  );

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
