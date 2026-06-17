import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import {
  buildJuniorSqlConversation,
  type JuniorSqlConversationInsert,
} from "../fixtures/sql";
import {
  createEmptyJuniorSqlFixture,
  createMigratedJuniorSqlFixture,
  hasJuniorPostgresTestDatabase,
} from "../fixtures/postgres/fixture";

async function recordConversation(
  fixture: Awaited<ReturnType<typeof createMigratedJuniorSqlFixture>>,
  overrides: Partial<JuniorSqlConversationInsert>,
): Promise<void> {
  const store = createSqlStore(fixture.executor);
  await store.migrate();
  const conversation = buildJuniorSqlConversation(overrides);
  await store.recordActivity({
    conversationId: conversation.conversationId,
    channelName: conversation.channelName ?? undefined,
    destination: conversation.destination ?? undefined,
    requester: conversation.requester ?? undefined,
    source: conversation.source ?? undefined,
    title: conversation.title ?? undefined,
    nowMs: conversation.updatedAt.getTime(),
  });
}

describe.skipIf(!hasJuniorPostgresTestDatabase())(
  "Junior Postgres test harness",
  () => {
    it("starts migrated transactional fixtures with the core schema", async () => {
      const fixture = await createMigratedJuniorSqlFixture();
      try {
        const rows = await fixture.executor.query<{ id: string }>(
          "SELECT id FROM junior_schema_migrations ORDER BY id ASC",
        );

        expect(rows).toEqual([{ id: "0001_conversation_core" }]);
      } finally {
        await fixture.close();
      }
    });

    it("rolls back transactional fixture data between tests", async () => {
      const first = await createMigratedJuniorSqlFixture();
      try {
        await recordConversation(first, {
          conversationId: "slack:C123:rollback-check",
        });
        await expect(
          first.executor.query(
            "SELECT conversation_id FROM junior_conversations WHERE conversation_id = $1",
            ["slack:C123:rollback-check"],
          ),
        ).resolves.toHaveLength(1);
      } finally {
        await first.close();
      }

      const second = await createMigratedJuniorSqlFixture();
      try {
        await expect(
          second.executor.query(
            "SELECT conversation_id FROM junior_conversations WHERE conversation_id = $1",
            ["slack:C123:rollback-check"],
          ),
        ).resolves.toHaveLength(0);
      } finally {
        await second.close();
      }
    });

    it("rolls back when callers close the transactional executor", async () => {
      const first = await createMigratedJuniorSqlFixture();
      await recordConversation(first, {
        conversationId: "slack:C123:executor-close-rollback",
      });
      await first.executor.close();
      await first.close();

      const second = await createMigratedJuniorSqlFixture();
      try {
        await expect(
          second.executor.query(
            "SELECT conversation_id FROM junior_conversations WHERE conversation_id = $1",
            ["slack:C123:executor-close-rollback"],
          ),
        ).resolves.toHaveLength(0);
      } finally {
        await second.close();
      }
    });

    it("keeps empty fixtures unmigrated until migration is explicit", async () => {
      const fixture = await createEmptyJuniorSqlFixture();
      try {
        await expect(
          fixture.executor.query<{ table_name: string }>(
            `
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name = 'junior_conversations'
`,
          ),
        ).resolves.toHaveLength(0);

        await migrateSchema(fixture.executor);

        await expect(
          fixture.executor.query<{ table_name: string }>(
            `
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name = 'junior_conversations'
`,
          ),
        ).resolves.toEqual([{ table_name: "junior_conversations" }]);
      } finally {
        await fixture.close();
      }
    });
  },
);
