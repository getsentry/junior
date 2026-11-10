import assert from "node:assert/strict";
import test from "node:test";
import {
  checkMigrationBackfills,
  hasUnboundedBackfill,
} from "./check-migration-backfills.mjs";

test("accepts backfills on new tables and backfills with a reason", async () => {
  const sql = [
    'CREATE TABLE "new_items" ("id" text PRIMARY KEY, "owner_id" text);--> statement-breakpoint',
    'UPDATE "new_items" SET "owner_id" = NULL;--> statement-breakpoint',
    "-- junior:bounded-backfill: only rows from the retired importer, which no longer writes",
    'UPDATE "items" SET "kind" = \'a\' WHERE "kind" IS NULL;--> statement-breakpoint',
    "DO $$",
    "BEGIN",
    "  -- junior:bounded-backfill: one row per install",
    '  DELETE FROM "items" WHERE "id" = \'legacy\';',
    "END $$;",
  ].join("\n");
  assert.equal(await hasUnboundedBackfill(sql), false);
});

const doBlock = (statement) =>
  ["DO $$", "BEGIN", `  ${statement}`, "END $$;"].join("\n");

for (const sql of [
  'UPDATE "items" SET "kind" = \'a\';',
  ["-- junior:bounded-backfill:", 'DELETE FROM "items";'].join("\n"),
  doBlock('DELETE FROM "items";'),
  [
    'CREATE TABLE IF NOT EXISTS "items" ("id" text PRIMARY KEY);',
    'DELETE FROM "items";',
  ].join("\n"),
]) {
  test(`rejects ${sql.split("\n").at(-1)}`, async () => {
    assert.equal(await hasUnboundedBackfill(sql), true);
  });
}

test("exempts baseline files only while they still have a backfill", async () => {
  const backfill = 'DELETE FROM "items";';
  const safe = 'ALTER TABLE "items" ADD COLUMN "note" text;';
  assert.deepEqual(
    (
      await checkMigrationBackfills(
        [
          ["0000_old.sql", backfill],
          ["0001_fixed.sql", safe],
          ["0002_new.sql", backfill],
        ],
        ["0000_old.sql", "0001_fixed.sql", "0003_gone.sql"],
      )
    ).map((error) => error.split(": ").slice(0, 2).join(": ")),
    [
      "0001_fixed.sql: has no unbounded backfill; remove it from scripts/migration-backfills-baseline.json",
      "0002_new.sql: unbounded-backfill",
      "0003_gone.sql: file not found; remove it from scripts/migration-backfills-baseline.json",
    ],
  );
});
