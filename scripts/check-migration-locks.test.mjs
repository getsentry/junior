import assert from "node:assert/strict";
import test from "node:test";
import {
  checkDrops,
  checkMigrationLocks,
  migrationLockViolations,
} from "./check-migration-locks.mjs";

test("accepts backfills on new tables, backfills with a reason, and DML in DO blocks", async () => {
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
  assert.deepEqual(await migrationLockViolations(sql), []);
});

const doBlock = (statement) =>
  ["DO $$", "BEGIN", `  ${statement}`, "END $$;"].join("\n");

const blockingCases = [
  ['UPDATE "items" SET "kind" = \'a\';', "unbounded-backfill"],
  [
    ["-- junior:bounded-backfill:", 'DELETE FROM "items";'].join("\n"),
    "unbounded-backfill",
  ],
  [
    [
      'CREATE TABLE IF NOT EXISTS "items" ("id" text PRIMARY KEY);',
      'DELETE FROM "items";',
    ].join("\n"),
    "unbounded-backfill",
  ],
  [
    doBlock('CREATE INDEX "items_owner_idx" ON "items" ("owner_id");'),
    "ddl-in-do-block",
  ],
  [
    doBlock(
      'ALTER TABLE "items" ADD CONSTRAINT "items_size_check" CHECK ("size" > 0);',
    ),
    "ddl-in-do-block",
  ],
];

for (const [sql, ruleId] of blockingCases) {
  const statement = sql
    .split("\n")
    .findLast((line) => !/^(?:DO|BEGIN|END)\b/.test(line))
    .trim();
  test(`rejects ${ruleId}: ${statement}`, async () => {
    assert.deepEqual(await migrationLockViolations(sql), [ruleId]);
  });
}

test("exempts baseline files only while they still break a rule", async () => {
  const backfill = 'DELETE FROM "items";';
  const safe = 'ALTER TABLE "items" ADD COLUMN "note" text;';
  assert.deepEqual(
    (
      await checkMigrationLocks(
        [
          ["0000_old.sql", backfill],
          ["0001_fixed.sql", safe],
          ["0002_new.sql", backfill],
        ],
        ["0000_old.sql", "0001_fixed.sql", "0003_gone.sql"],
      )
    ).map((error) => error.split(": ").slice(0, 2).join(": ")),
    [
      "0001_fixed.sql: breaks no lock rule; remove it from scripts/migration-locks-baseline.json",
      "0002_new.sql: unbounded-backfill",
      "0003_gone.sql: file not found; remove it from scripts/migration-locks-baseline.json",
    ],
  );
});

test("requires a drop to name a release that is out, except in baseline files", () => {
  const drop = 'ALTER TABLE "items" DROP COLUMN "kind";';
  const ignore = (reason) =>
    [`-- squawk-ignore ban-drop-column${reason}`, drop].join("\n");
  const warning = (file) => ({
    file,
    line: 0,
    column: 22,
    rule_name: "ban-drop-column",
    message: "dropping a column may break existing clients",
  });
  assert.deepEqual(
    checkDrops(
      [
        ["0000_old.sql", drop],
        ["0001_fixed.sql", 'ALTER TABLE "items" ADD COLUMN "note" text;'],
        ["0002_new.sql", drop],
        ["0003_no_reason.sql", ignore("")],
        ["0004_unreleased.sql", ignore(" -- unused since 0.316.0")],
        ["0005_released.sql", ignore(" -- unused since 0.99.1")],
      ],
      [warning("0000_old.sql"), warning("0002_new.sql")],
      ["0000_old.sql", "0001_fixed.sql", "0009_gone.sql"],
      "0.315.0",
    ).map((error) => error.split(": ").slice(0, 2).join(": ")),
    [
      "0002_new.sql:0:22: ban-drop-column",
      "0001_fixed.sql: has no drop or rename; remove it from scripts/migration-drops-baseline.json",
      "0003_no_reason.sql:1: drop-without-release",
      "0004_unreleased.sql:1: drop-without-release",
      "0009_gone.sql: file not found; remove it from scripts/migration-drops-baseline.json",
    ],
  );
});
