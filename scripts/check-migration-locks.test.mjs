import assert from "node:assert/strict";
import test from "node:test";
import {
  checkMigrationLocks,
  migrationLockViolations,
} from "./check-migration-locks.mjs";

test("accepts statements that do not block an existing table", () => {
  const sql = [
    'CREATE TABLE "new_items" ("id" text PRIMARY KEY, "owner_id" text);--> statement-breakpoint',
    'ALTER TABLE "new_items" ADD CONSTRAINT "new_items_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id");--> statement-breakpoint',
    'CREATE INDEX "new_items_owner_idx" ON "new_items" USING btree ("owner_id");--> statement-breakpoint',
    'ALTER TABLE "items" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint',
    'ALTER TABLE "items" ADD COLUMN "seen_at" timestamp with time zone DEFAULT now();--> statement-breakpoint',
    'ALTER TABLE "items" ADD CONSTRAINT "items_kind_check" CHECK ("items"."kind" in (\'a\')) NOT VALID;--> statement-breakpoint',
    'ALTER TABLE "items" ALTER COLUMN "owner_id" DROP NOT NULL;',
    "DO $$",
    "BEGIN",
    "  IF to_regclass('items_owner_idx') IS NULL THEN",
    "    -- junior:concurrent-index",
    '    CREATE INDEX "items_owner_idx" ON "items" USING btree ("owner_id");',
    "  END IF;",
    "END $$;",
    'UPDATE "new_items" SET "owner_id" = NULL;',
    "-- junior:bounded-backfill: only rows from the retired importer, which no longer writes",
    'UPDATE "items" SET "kind" = \'a\' WHERE "kind" IS NULL;',
  ].join("\n");
  assert.deepEqual(migrationLockViolations(sql), []);
});

test("rejects statements that lock an existing table while they scan or rewrite it", () => {
  const sql = [
    'CREATE INDEX "items_owner_idx" ON "items" USING btree ("owner_id");--> statement-breakpoint',
    'CREATE INDEX CONCURRENTLY "items_kind_idx" ON "items" ("kind");--> statement-breakpoint',
    'ALTER TABLE "items" ADD CONSTRAINT "items_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id");--> statement-breakpoint',
    'ALTER TABLE "items" ADD CONSTRAINT "items_key_unique" UNIQUE("key");--> statement-breakpoint',
    'ALTER TABLE "items" ALTER COLUMN "size" SET DATA TYPE bigint;--> statement-breakpoint',
    'ALTER TABLE "items" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint',
    'ALTER TABLE "items" ADD COLUMN "token" uuid DEFAULT gen_random_uuid();',
    'CREATE TABLE IF NOT EXISTS "kept_items" ("id" text PRIMARY KEY);',
    'CREATE INDEX "kept_items_id_idx" ON "kept_items" ("id");',
    "-- junior:concurrent-index",
    'CREATE UNIQUE INDEX "items_key_uidx" ON "items" ("key");',
    'UPDATE "items" SET "kind" = \'a\';',
    "-- junior:bounded-backfill:",
    'DELETE FROM "items" WHERE "kind" IS NULL;',
  ].join("\n");
  assert.deepEqual(migrationLockViolations(sql), [
    "index-without-concurrent-build",
    "concurrently-in-transaction",
    "index-without-concurrent-build",
    "unsupported-concurrent-index",
    "constraint-without-not-valid",
    "unique-without-index",
    "column-type-change",
    "set-not-null",
    "volatile-default",
    "unbounded-backfill",
    "unbounded-backfill",
  ]);
});

test("exempts baseline files only while they still break a rule", () => {
  const blocking = 'CREATE INDEX "items_idx" ON "items" ("id");';
  const safe = 'ALTER TABLE "items" ADD COLUMN "note" text;';
  assert.deepEqual(
    checkMigrationLocks(
      [
        ["0000_old.sql", blocking],
        ["0001_fixed.sql", safe],
        ["0002_new.sql", blocking],
      ],
      ["0000_old.sql", "0001_fixed.sql", "0003_gone.sql"],
    ).map((error) => error.split(": ").slice(0, 2).join(": ")),
    [
      "0001_fixed.sql: breaks no lock rule; remove it from scripts/migration-locks-baseline.json",
      "0002_new.sql: index-without-concurrent-build",
      "0003_gone.sql: file not found; remove it from scripts/migration-locks-baseline.json",
    ],
  );
});
