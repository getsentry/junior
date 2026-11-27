import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const GITHUB_MIGRATIONS = path.resolve(
  process.cwd(),
  "../junior-github/migrations",
);

// The GitHub migration that copies each opener's pull request id from the
// code index.
const backfill = readMigrationFiles({
  migrationsFolder: GITHUB_MIGRATIONS,
}).find((entry) =>
  entry.sql.some((statement) =>
    statement.includes("SET pull_request_id = change.provider_id"),
  ),
);

describe("pull request requester id migration", () => {
  it("finds an opener's pull request id by name, or else through its Conversation after a repository rename", async () => {
    if (!backfill)
      throw new Error("pull_request_requester_ids_backfill not found");
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      await migratePluginSchemas(fixture.sql, [
        { dir: GITHUB_MIGRATIONS, pluginName: "github" },
      ]);
      await fixture.sql.execute(
        `INSERT INTO junior_code_repositories (id, name, provider, provider_id, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', 'getsentry/junior', 'github', 'R_1', now()), ('00000000-0000-4000-8000-000000000002', 'getsentry/junior-next', 'github', 'R_2', now()), ('00000000-0000-4000-8000-000000000003', 'getsentry/other', 'github', 'R_3', now())`,
      );
      const change = (
        id: string,
        repository: number,
        number: number,
        conversationId: string,
      ) =>
        fixture.sql.execute(
          `INSERT INTO junior_code_changes (id, conversation_ids, number, opened_at, provider, provider_id, repository_id, state, updated_at) VALUES (gen_random_uuid(), ARRAY['${conversationId}'], ${number}, now(), 'github', '${id}', '00000000-0000-4000-8000-00000000000${repository}', 'open', now())`,
        );
      // #1 kept its repository's name.
      await change("PR_1", 1, 1, "slack:C123:1.000001");
      // The repository of #2 was renamed after Junior opened it.
      await change("PR_2", 2, 2, "slack:C123:1.000002");
      // A Conversation opened #3 in two repositories that were both renamed,
      // so the number names no one change.
      await change("PR_3_A", 2, 3, "slack:C123:1.000003");
      await change("PR_3_B", 3, 3, "slack:C123:1.000003");
      // The opener rows still have the old names.
      await fixture.sql.execute(
        `INSERT INTO junior_github_pull_request_requesters (repository_full_name, number, identity_id, conversation_id, created_at, updated_at) VALUES ('getsentry/junior', 1, 'identity:ana', 'slack:C123:1.000001', now(), now()), ('getsentry/junior-old', 2, 'identity:ana', 'slack:C123:1.000002', now(), now()), ('getsentry/junior-old', 3, 'identity:ana', 'slack:C123:1.000003', now(), now()), ('getsentry/junior-old', 2, 'identity:ben', NULL, now(), now())`,
      );

      for (const statement of backfill.sql) {
        await fixture.sql.execute(statement);
      }

      expect(
        await fixture.sql.query(
          `SELECT number, identity_id, pull_request_id FROM junior_github_pull_request_requesters ORDER BY number, identity_id`,
        ),
      ).toEqual([
        { identity_id: "identity:ana", number: 1, pull_request_id: "PR_1" },
        { identity_id: "identity:ana", number: 2, pull_request_id: "PR_2" },
        // A requester who is not the opener has no Conversation and no id.
        { identity_id: "identity:ben", number: 2, pull_request_id: null },
        { identity_id: "identity:ana", number: 3, pull_request_id: null },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
