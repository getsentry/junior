import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const migrations = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
});
// The `inbox_item_owners` migration, and the one after it that makes a
// subject's open item unique in all provider tenants.
const owners = migrations.find((entry) =>
  entry.sql.some((statement) =>
    statement.includes('ALTER COLUMN "owner_id" DROP NOT NULL'),
  ),
);
const index = migrations.find((entry) =>
  entry.sql.some((statement) =>
    statement.includes('"junior_inbox_items_open_subject_key_uidx"'),
  ),
);

/** Add an open reply item as a worker of the last release does. */
function oldWorkerItem(
  id: string,
  tenant: string,
  updatedAt: string,
  subjectId = "slack:C123:1.000001",
): string {
  return `INSERT INTO junior_inbox_items (id, kind, status, visibility, title, body, subject_kind, subject_id, owner_kind, owner_id, provider, provider_tenant_id, created_at, updated_at) VALUES ('${id}', 'notice', 'open', 'public', 'Reply', 'Junior replied.', 'reply', '${subjectId}', 'conversation', '${subjectId}', 'slack', '${tenant}', '${updatedAt}', '${updatedAt}')`;
}

describe("inbox item owner migration", () => {
  it("keeps the newest open item of a subject from all tenants, and old and new workers can still add items", async () => {
    if (!owners || !index) {
      throw new Error("inbox_item_owners migrations not found");
    }
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      // Before the migration, each provider tenant had its own open item of
      // a subject.
      await fixture.sql.execute(
        `DROP INDEX "junior_inbox_items_open_subject_key_uidx"`,
      );
      await fixture.sql.execute(
        oldWorkerItem("older", "T123", "2026-10-01T12:00:00Z"),
      );
      await fixture.sql.execute(
        oldWorkerItem("newer", "T999", "2026-10-02T12:00:00Z"),
      );
      await fixture.sql.execute(
        oldWorkerItem(
          "other",
          "T123",
          "2026-10-01T12:00:00Z",
          "slack:C123:2.000001",
        ),
      );

      for (const statement of [...owners.sql, ...index.sql]) {
        await fixture.sql.execute(statement);
      }

      expect(
        await fixture.sql.query(
          `SELECT id, status, close_reason FROM junior_inbox_items ORDER BY id`,
        ),
      ).toEqual([
        { close_reason: null, id: "newer", status: "open" },
        {
          close_reason: "A newer item asks about the same subject.",
          id: "older",
          status: "dismissed",
        },
        { close_reason: null, id: "other", status: "open" },
      ]);
      // The new index keeps one open item per subject in all tenants.
      await expect(
        fixture.sql.execute(
          oldWorkerItem(
            "again",
            "T123",
            "2026-10-03T12:00:00Z",
            "slack:C123:2.000001",
          ),
        ),
      ).rejects.toThrow(/junior_inbox_items_open_subject_key_uidx/);
      // A worker of the last release still writes the owner columns, and a
      // new worker leaves them empty.
      await fixture.sql.execute(
        oldWorkerItem(
          "old-worker",
          "T123",
          "2026-10-03T12:00:00Z",
          "slack:C123:3.000001",
        ),
      );
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_items (id, kind, status, title, body, subject_kind, subject_id, created_at, updated_at) VALUES ('new-worker', 'notice', 'open', 'Reply', 'Junior replied.', 'reply', 'slack:C123:4.000001', now(), now())`,
      );
      expect(
        await fixture.sql.query(
          `SELECT id, owner_id, visibility FROM junior_inbox_items WHERE id IN ('old-worker', 'new-worker') ORDER BY id`,
        ),
      ).toEqual([
        { id: "new-worker", owner_id: null, visibility: null },
        {
          id: "old-worker",
          owner_id: "slack:C123:3.000001",
          visibility: "public",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
