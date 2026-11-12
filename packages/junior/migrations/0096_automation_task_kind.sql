-- An Automation task is an instruction or a skill. The `instruction` column
-- holds only an instruction, and the new `skill` column holds only a skill.
ALTER TABLE "junior_automations" ALTER COLUMN "instruction" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_automations" ADD COLUMN "skill" text;--> statement-breakpoint
-- An Automation with a blank instruction could not run. Block it until its
-- creator writes an instruction or chooses a skill.
-- junior:bounded-backfill: changes only active or paused Automations with a blank instruction, which cannot run, so few rows match.
UPDATE "junior_automations"
SET
  "status" = 'blocked',
  "status_reason" = 'This automation has no instruction. Write one or choose a skill, then resume it.'
WHERE "record"->'task' ? 'text'
  AND btrim("record"->'task'->>'text', E' \t\r\n') = ''
  AND "status" IN ('active', 'paused');--> statement-breakpoint
-- Rewrite the old `{ text }` task as an instruction task. A blank
-- instruction gets a placeholder, because an instruction cannot be empty.
-- junior:bounded-backfill: runs once over the Automations of one install, which are few, and each row changes once.
WITH "old" AS (
  SELECT
    "id",
    coalesce(
      nullif(btrim("record"->'task'->>'text', E' \t\r\n'), ''),
      'No instruction was saved.'
    ) AS "instruction"
  FROM "junior_automations"
  WHERE "record"->'task' ? 'text'
)
UPDATE "junior_automations"
SET
  "instruction" = "old"."instruction",
  "record" = jsonb_set(
    "record",
    '{task}',
    jsonb_build_object('kind', 'instruction', 'instruction', "old"."instruction")
  )
FROM "old"
WHERE "junior_automations"."id" = "old"."id";--> statement-breakpoint
-- Saved versions use the same `task` object, so history and diffs have one shape.
-- junior:bounded-backfill: runs once over the saved versions of one install, which are few, and each row changes once.
UPDATE "junior_automation_versions"
SET "definition" = ("definition" - 'instruction') || jsonb_build_object(
  'task',
  jsonb_build_object(
    'kind', 'instruction',
    'instruction', coalesce(
      nullif(btrim("definition"->>'instruction', E' \t\r\n'), ''),
      'No instruction was saved.'
    )
  )
)
WHERE "definition" ? 'instruction';--> statement-breakpoint
-- Finds the Automations that run a skill. Before this migration runs,
-- junior upgrade builds the marked index with CREATE INDEX CONCURRENTLY, so
-- the build below does not block writes.
DO $$
BEGIN
  -- Even CREATE INDEX IF NOT EXISTS takes a write-blocking table lock.
  IF to_regclass('junior_automations_skill_idx') IS NULL THEN
    -- junior:concurrent-index
    CREATE INDEX "junior_automations_skill_idx" ON "junior_automations" USING btree ("skill","created_at_ms","id") WHERE "junior_automations"."status" <> 'deleted' AND "junior_automations"."skill" IS NOT NULL;
  END IF;

  -- A failed concurrent build can leave an index that exists but cannot be used.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'junior_automations_skill_idx'::regclass
      AND indrelid = 'junior_automations'::regclass
      AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'The Automation skill index is not valid and ready. Repair the concurrent build before running junior upgrade.';
  END IF;
END $$;--> statement-breakpoint
-- The backfill above makes every row pass. NOT VALID skips the scan under
-- lock and still checks every new write. A later migration validates it.
ALTER TABLE "junior_automations" ADD CONSTRAINT "junior_automations_task_check" CHECK (("junior_automations"."instruction" is null) <> ("junior_automations"."skill" is null)) NOT VALID;
