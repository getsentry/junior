ALTER TABLE "junior_automations" ADD COLUMN "last_run_at_ms" bigint;--> statement-breakpoint
-- The list orders by this column, and each new run write refreshes it. A run
-- that the old runtime writes during the rollout leaves an older time until
-- that Automation runs again.
-- junior:bounded-backfill: one row per listed Automation, and each row reads one index range of its runs; deleted Automations are skipped because no list shows them.
UPDATE "junior_automations"
SET "last_run_at_ms" = (
  SELECT max("completed_at_ms")
  FROM "junior_automation_runs"
  WHERE "junior_automation_runs"."automation_id" = "junior_automations"."id"
    AND "junior_automation_runs"."status" IN ('blocked', 'completed', 'failed')
    AND "junior_automation_runs"."completed_at_ms" IS NOT NULL
)
WHERE "status" <> 'deleted';
