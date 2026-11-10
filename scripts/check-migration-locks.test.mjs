import assert from "node:assert/strict";
import test from "node:test";
import {
  checkMigrationLocks,
  migrationLockViolations,
} from "./check-migration-locks.mjs";

test("accepts statements that do not block an existing table", async () => {
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
    "END $$;--> statement-breakpoint",
    "-- junior:concurrent-index",
    'CREATE INDEX "items_kind_idx" ON "items" USING btree ("kind");--> statement-breakpoint',
    "DO $$",
    "BEGIN",
    "  IF to_regclass('items_size_idx') IS NULL THEN",
    "    -- junior:concurrent-index",
    '    CREATE INDEX "items_size_idx" ON "items" USING btree ("size");',
    "  END IF;",
    "END $$;",
    'UPDATE "new_items" SET "owner_id" = NULL;',
    "-- junior:bounded-backfill: only rows from the retired importer, which no longer writes",
    'UPDATE "items" SET "kind" = \'a\' WHERE "kind" IS NULL;',
  ].join("\n");
  assert.deepEqual(await migrationLockViolations(sql), []);
});

const doBlock = (statement) =>
  ["DO $$", "BEGIN", `  ${statement}`, "END $$;"].join("\n");

const blockingCases = [
  [
    'CREATE INDEX "items_owner_idx" ON "items" USING btree ("owner_id");',
    "index-without-concurrent-build",
  ],
  [
    doBlock('CREATE INDEX "items_owner_idx" ON "items" ("owner_id");'),
    "index-without-concurrent-build",
  ],
  [
    [
      'CREATE TABLE IF NOT EXISTS "items" ("id" text PRIMARY KEY);',
      'CREATE INDEX "items_id_idx" ON "items" ("id");',
    ].join("\n"),
    "index-without-concurrent-build",
  ],
  [
    [
      "-- junior:concurrent-index",
      'CREATE UNIQUE INDEX "items_key_uidx" ON "items" ("key");',
    ].join("\n"),
    "unsupported-concurrent-index",
  ],
  [
    'CREATE INDEX CONCURRENTLY "items_kind_idx" ON "items" ("kind");',
    "concurrently-in-transaction",
  ],
  ['DROP INDEX CONCURRENTLY "items_kind_idx";', "concurrently-in-transaction"],
  [
    'ALTER TABLE "items" ADD CONSTRAINT "items_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id");',
    "constraint-without-not-valid",
  ],
  [
    doBlock(
      'ALTER TABLE "items" ADD CONSTRAINT "items_size_check" CHECK ("size" > 0);',
    ),
    "constraint-without-not-valid",
  ],
  [
    'ALTER TABLE "items" ADD COLUMN "owner_id" text REFERENCES "owners"("id");',
    "constraint-without-not-valid",
  ],
  [
    'ALTER TABLE "items" ADD CONSTRAINT "items_key_unique" UNIQUE("key");',
    "unique-without-index",
  ],
  [
    'ALTER TABLE "items" ALTER COLUMN "size" SET DATA TYPE bigint;',
    "column-type-change",
  ],
  ['ALTER TABLE "items" ALTER COLUMN "owner_id" SET NOT NULL;', "set-not-null"],
  [
    'ALTER TABLE "items" ADD COLUMN "token" uuid DEFAULT gen_random_uuid();',
    "volatile-default",
  ],
  ['UPDATE "items" SET "kind" = \'a\';', "unbounded-backfill"],
  [
    ["-- junior:bounded-backfill:", 'DELETE FROM "items";'].join("\n"),
    "unbounded-backfill",
  ],
];

for (const [sql, ruleId] of blockingCases) {
  const statement = sql
    .split("\n")
    .map((line) => line.trim())
    .find((line) => !/^(?:DO|BEGIN|--)\b|^--/.test(line));
  test(`rejects ${ruleId}: ${statement}`, async () => {
    assert.deepEqual(await migrationLockViolations(sql), [ruleId]);
  });
}

test("exempts baseline files only while they still break a rule", async () => {
  const blocking = 'CREATE INDEX "items_idx" ON "items" ("id");';
  const safe = 'ALTER TABLE "items" ADD COLUMN "note" text;';
  assert.deepEqual(
    (
      await checkMigrationLocks(
        [
          ["0000_old.sql", blocking],
          ["0001_fixed.sql", safe],
          ["0002_new.sql", blocking],
        ],
        ["0000_old.sql", "0001_fixed.sql", "0003_gone.sql"],
      )
    ).map((error) => error.split(": ").slice(0, 2).join(": ")),
    [
      "0001_fixed.sql: breaks no lock rule; remove it from scripts/migration-locks-baseline.json",
      "0002_new.sql: index-without-concurrent-build",
      "0003_gone.sql: file not found; remove it from scripts/migration-locks-baseline.json",
    ],
  );
});
