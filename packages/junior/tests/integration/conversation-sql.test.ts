import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  migrations as declaredMigrations,
  migrateSchema,
} from "@/chat/conversations/sql/migrations";
import { schema } from "@/chat/conversations/sql/schema";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { recordAgentTurnSessionSummary } from "@/chat/state/turn-session";
import {
  buildJuniorSqlConversation,
  createLocalJuniorSqlFixture,
} from "../fixtures/sql";

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
          Object.values(getTableColumns(table)).map((column) => column.name),
        ]),
      );

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
          "junior_conversations_requester_activity_idx",
          "junior_destinations_pkey",
          "junior_destinations_provider_destination_uidx",
          "junior_identities_kind_provider_idx",
          "junior_identities_pkey",
          "junior_identities_provider_subject_uidx",
          "junior_identities_user_idx",
          "junior_identities_verified_email_idx",
          "junior_schema_migrations_pkey",
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
  requester_json,
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
          JSON.stringify(conversation.requester),
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
        requester_json: unknown;
        source: string;
        title: string;
      }>(
        `
SELECT conversation_id, source, destination_json, requester_json, channel_name, title, execution_status
FROM junior_conversations
WHERE conversation_id = $1
`,
        ["slack:C123:1718123456.000000"],
      );
      const migrationRows = await fixture.sql.query<{ id: string }>(
        "SELECT id FROM junior_schema_migrations ORDER BY id ASC",
      );

      expect(migrationRows).toEqual(
        declaredMigrations.map((migration) => ({ id: migration.id })),
      );
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
        requester_json: {
          platform: "slack",
          slackUserId: "U123",
          teamId: "T123",
        },
      });
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
          status: "idle",
        },
        source: "scheduler",
      });
    } finally {
      await disconnectStateAdapter();
      await fixture.close();
    }
  });
});
