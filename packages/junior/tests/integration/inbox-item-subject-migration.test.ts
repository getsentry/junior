import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const migration = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
}).find((entry) =>
  entry.sql.some((statement) =>
    statement.includes('CREATE TRIGGER "junior_inbox_items_legacy_subject"'),
  ),
);
// The steps of 0170 that close the open items that now share a subject,
// up to the unique index that keeps one open item for each subject.
const start =
  migration?.sql.findIndex((statement) =>
    statement.includes("'A newer item asks about the same subject.'"),
  ) ?? -1;
const end =
  migration?.sql.findIndex((statement) =>
    statement.includes(
      'CREATE UNIQUE INDEX "junior_inbox_items_open_subject_uidx"',
    ),
  ) ?? -1;

const PULL_REQUEST = "getsentry/junior#946";

/** Add an open item as a worker of the last release does: with no subject. */
function legacyItem(id: string, prefix: string, updatedAt: string): string {
  return `INSERT INTO junior_inbox_items (id, kind, status, visibility, title, body, dedupe_key, owner_id, created_at, updated_at) VALUES ('${id}', 'action', 'open', 'public', 'PR #946', 'GitHub asks about #946.', 'plugin:github:${prefix}:${PULL_REQUEST}', 'slack:C123:1.000001', '${updatedAt}', '${updatedAt}')`;
}

describe("inbox item subject migration", () => {
  it("keeps one open item for each subject, with the snoozes and without the pushes of the items it closes", async () => {
    if (!migration || start < 0 || end < start) {
      throw new Error("0170 subject steps not found");
    }
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      // Before 0170, the old dedupe keys of one pull request's asks differ.
      await fixture.sql.execute(
        `DROP INDEX "junior_inbox_items_open_subject_uidx"`,
      );
      for (const user of ["ana", "ben"]) {
        await fixture.sql.execute(
          `INSERT INTO junior_users (id, primary_email, primary_email_normalized, created_at, updated_at) VALUES ('user:${user}', '${user}@example.com', '${user}@example.com', now(), now())`,
        );
      }
      await fixture.sql.execute(
        legacyItem(
          "review",
          "pull-request-review-requested",
          "2026-10-01T12:00:00Z",
        ),
      );
      await fixture.sql.execute(
        legacyItem("merge", "pull-request-ready", "2026-10-02T12:00:00Z"),
      );
      // Ana snoozed only the review ask. Ben snoozed both asks.
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_snoozes (id, user_id, inbox_item_id, state, created_at) VALUES ('ana-review', 'user:ana', 'review', 'snoozed', now()), ('ben-review', 'user:ben', 'review', 'snoozed', now()), ('ben-merge', 'user:ben', 'merge', 'snoozed', now())`,
      );
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_item_deliveries (item_id, user_id, channel, event, status, created_at, updated_at) VALUES ('review', 'user:ana', 'web_push', 'created', 'sent', now(), now()), ('merge', 'user:ben', 'web_push', 'created', 'sent', now(), now())`,
      );

      for (const statement of migration.sql.slice(start, end + 1)) {
        await fixture.sql.execute(statement);
      }

      expect(
        await fixture.sql.query(
          `SELECT id, status FROM junior_inbox_items ORDER BY id`,
        ),
      ).toEqual([
        { id: "merge", status: "open" },
        { id: "review", status: "dismissed" },
      ]);
      // Ana's snooze still hides the item that stays open. Ben keeps his
      // own snooze of it.
      expect(
        await fixture.sql.query(
          `SELECT id, inbox_item_id, state FROM junior_inbox_snoozes WHERE state = 'snoozed' AND inbox_item_id = 'merge' ORDER BY id`,
        ),
      ).toEqual([
        { id: "ana-review", inbox_item_id: "merge", state: "snoozed" },
        { id: "ben-merge", inbox_item_id: "merge", state: "snoozed" },
      ]);
      // The devices close the push of the closed item, as for any close.
      expect(
        await fixture.sql.query(
          `SELECT item_id, status FROM junior_inbox_item_deliveries ORDER BY item_id`,
        ),
      ).toEqual([
        { item_id: "merge", status: "sent" },
        { item_id: "review", status: "cleared" },
      ]);
      // A worker of the last release cannot add a second open item for the
      // pull request while this release rolls out.
      await expect(
        fixture.sql.execute(
          legacyItem("action", "pull-request-action", "2026-10-03T12:00:00Z"),
        ),
      ).rejects.toThrow(/duplicate key/);
    } finally {
      await fixture.close();
    }
  });
});
