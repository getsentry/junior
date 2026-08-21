import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { applyCoreMigrations } from "../fixtures/conversation-sql-migrations";
import { createEmptyJuniorSqlFixture } from "../fixtures/postgres/fixture";

const coreMigrations = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
});

describe("conversation archive migration", () => {
  it("preserves archive state for a root actor without a participant row", async () => {
    const fixture = await createEmptyJuniorSqlFixture();
    const migrationIndex = coreMigrations.findIndex((migration) =>
      migration.sql.some((statement) =>
        statement.includes('DROP COLUMN "archived_at"'),
      ),
    );
    const migration = coreMigrations[migrationIndex];
    if (!migration) throw new Error("Conversation archive migration not found");

    try {
      await applyCoreMigrations(fixture, coreMigrations, 0, migrationIndex);
      await fixture.sql.execute(`
INSERT INTO junior_users (
  id, primary_email, primary_email_normalized, created_at, updated_at
) VALUES (
  'archive-user', 'archive@example.com', 'archive@example.com',
  '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z'
);
INSERT INTO junior_identities (
  id, kind, provider, provider_tenant_id, provider_subject_id, user_id,
  created_at, updated_at
) VALUES (
  'archive-identity', 'user', 'slack', 'T1', 'U1', 'archive-user',
  '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z'
);
INSERT INTO junior_conversations (
  conversation_id, actor_identity_id, created_at, last_activity_at, updated_at,
  execution_status, root_conversation_id, archived_at
) VALUES (
  'slack:C1:1', 'archive-identity', '2026-08-21T00:00:00.000Z',
  '2026-08-21T01:00:00.000Z', '2026-08-21T01:00:00.000Z', 'idle',
  'slack:C1:1', '2026-08-21T02:00:00.000Z'
);
`);
      for (const statement of migration.sql) {
        await fixture.sql.execute(statement);
      }

      const [participant] = await fixture.sql.query<{
        archivedAt: Date;
        rootConversationId: string;
        userId: string;
      }>(`
SELECT
  user_id AS "userId",
  root_conversation_id AS "rootConversationId",
  archived_at AS "archivedAt"
FROM junior_conversation_participants
`);
      expect(participant).toMatchObject({
        rootConversationId: "slack:C1:1",
        userId: "archive-user",
      });
      expect(participant?.archivedAt.toISOString()).toBe(
        "2026-08-21T02:00:00.000Z",
      );
    } finally {
      await fixture.close();
    }
  }, 10_000);
});
