-- Repeat the `{ text }` task rewrite of 0096_automation_task_kind.
-- `junior upgrade` runs migrations before the new runtime takes traffic. In
-- that window the old runtime still created Automations, and it wrote the old
-- `{ text }` task and an `instruction` version definition after 0096 ran.
-- The new runtime cannot read those rows. Each statement changes only rows
-- with the old shape, so this migration is safe to run again.
-- junior:bounded-backfill: changes only active or paused Automations with an old, blank task, which cannot run, so few rows match.
UPDATE "junior_automations"
SET
  "status" = 'blocked',
  "status_reason" = 'This automation has no instruction. Write one or choose a skill, then resume it.'
WHERE "record"->'task' ? 'text'
  AND btrim("record"->'task'->>'text', E' \t\r\n') = ''
  AND "status" IN ('active', 'paused');--> statement-breakpoint
-- junior:bounded-backfill: changes only Automations with an old task, which the old runtime wrote during one rollout, so few rows match.
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
-- junior:bounded-backfill: changes only saved versions with an old definition, which the old runtime wrote during one rollout, so few rows match.
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
WHERE "definition" ? 'instruction';
