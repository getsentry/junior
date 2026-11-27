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
    statement.includes('TRIGGER "junior_inbox_items_legacy_write"'),
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
  return `INSERT INTO junior_inbox_items (id, kind, status, visibility, title, body, dedupe_key, subject_kind, subject_id, owner_kind, owner_id, provider, provider_tenant_id, created_at, updated_at) VALUES ('${id}', 'notice', 'open', 'public', 'Reply', 'Junior replied.', 'reply:${subjectId}', 'reply', '${subjectId}', 'conversation', '${subjectId}', 'slack', '${tenant}', '${updatedAt}', '${updatedAt}')`;
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

      // Ana snoozed the older item and has a push of it. Ben is on the
      // newer one.
      for (const user of ["ana", "ben"]) {
        await fixture.sql.execute(
          `INSERT INTO junior_users (id, primary_email, primary_email_normalized, created_at, updated_at) VALUES ('user:${user}', '${user}@example.com', '${user}@example.com', now(), now())`,
        );
      }
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_item_assignees (item_id, user_id) VALUES ('older', 'user:ana'), ('newer', 'user:ben')`,
      );
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_snoozes (id, user_id, inbox_item_id, state, created_at) VALUES ('ana-older', 'user:ana', 'older', 'snoozed', now())`,
      );
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_item_deliveries (item_id, user_id, channel, event, status, created_at, updated_at) VALUES ('older', 'user:ana', 'web_push', 'created', 'sent', now(), now())`,
      );

      for (const statement of [...owners.sql, ...index.sql]) {
        await fixture.sql.execute(statement);
      }

      // The item that stays open keeps Ana's ask and snooze, and her
      // devices close the older item.
      expect(
        await fixture.sql.query(
          `SELECT item_id, user_id FROM junior_inbox_item_assignees ORDER BY item_id, user_id`,
        ),
      ).toEqual([
        { item_id: "newer", user_id: "user:ana" },
        { item_id: "newer", user_id: "user:ben" },
        { item_id: "older", user_id: "user:ana" },
      ]);
      expect(
        await fixture.sql.query(
          `SELECT inbox_item_id FROM junior_inbox_snoozes WHERE id = 'ana-older'`,
        ),
      ).toEqual([{ inbox_item_id: "newer" }]);
      expect(
        await fixture.sql.query(
          `SELECT status FROM junior_inbox_item_deliveries WHERE item_id = 'older'`,
        ),
      ).toEqual([{ status: "cleared" }]);

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
            "T999",
            "2026-10-03T12:00:00Z",
            "slack:C123:2.000001",
          ),
        ),
      ).rejects.toThrow(/junior_inbox_items_open_subject_key_uidx/);
      // A worker of the last release writes the old columns itself. For a
      // new worker, the trigger writes them from the owner that it names
      // for its transaction, so the last release can still read the row.
      await fixture.sql.execute(
        oldWorkerItem(
          "old-worker",
          "T123",
          "2026-10-03T12:00:00Z",
          "slack:C123:3.000001",
        ),
      );
      const newWorkerItem = (id: string, subjectId: string) =>
        `INSERT INTO junior_inbox_items (id, kind, status, title, body, subject_kind, subject_id, created_at, updated_at) SELECT '${id}', 'notice', 'open', 'Reply', 'Junior replied.', 'reply', '${subjectId}', now(), now()`;
      await fixture.sql.execute(
        `WITH owner AS (SELECT set_config('junior.inbox_item_owner_kind', 'conversation', true), set_config('junior.inbox_item_owner_id', 'slack:C123:4.000001', true)) ${newWorkerItem("new-worker", "slack:C123:4.000001")} FROM owner`,
      );
      expect(
        await fixture.sql.query(
          `SELECT id, dedupe_key, owner_kind, owner_id, visibility FROM junior_inbox_items WHERE id IN ('old-worker', 'new-worker') ORDER BY id`,
        ),
      ).toEqual([
        {
          dedupe_key: "reply:slack:C123:4.000001",
          id: "new-worker",
          owner_id: "slack:C123:4.000001",
          owner_kind: "conversation",
          // The owner Conversation has no Destination here.
          visibility: "private",
        },
        {
          dedupe_key: "reply:slack:C123:3.000001",
          id: "old-worker",
          owner_id: "slack:C123:3.000001",
          owner_kind: "conversation",
          visibility: "public",
        },
      ]);
      // A new write that names no owner fails, so no row goes without one.
      await expect(
        fixture.sql.execute(newWorkerItem("no-owner", "slack:C123:5.000001")),
      ).rejects.toThrow(/has no owner to write/);
    } finally {
      await fixture.close();
    }
  });
});
