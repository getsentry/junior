import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/metadata/sql/migrations";
import { schema } from "@/chat/metadata/sql/schema";
import {
  buildJuniorSqlConversation,
  createLocalJuniorSqlFixture,
} from "../fixtures/sql";

describe("conversation metadata SQL local mode", () => {
  it("creates migrated tables matching the Drizzle schema", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.executor);

      const rows = await fixture.executor.query<{
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
      expect(actual.get("junior_conversation_inbound_messages")).toContain(
        "input_json",
      );
    } finally {
      await fixture.close();
    }
  });

  it("runs migrations and stores metadata through the Drizzle schema", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.executor);
      await migrateSchema(fixture.executor);

      const conversation = buildJuniorSqlConversation({
        conversationId: "slack:C123:1718123456.000000",
      });

      await fixture.executor.execute(
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

      const rows = await fixture.executor.query<{
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
      const migrations = await fixture.executor.query<{ id: string }>(
        "SELECT id FROM junior_schema_migrations ORDER BY id ASC",
      );

      expect(migrations).toEqual([{ id: migrations[0].id }]);
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
});
