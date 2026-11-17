ALTER TABLE "junior_automations" ADD COLUMN "last_run_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "junior_automations" ADD COLUMN "last_run_status" text;--> statement-breakpoint
-- The list orders and filters by these columns, and each new run write
-- refreshes them. A run that the old runtime writes during the rollout
-- leaves an older run until that Automation runs again.
-- junior:bounded-backfill: one row per listed Automation, and each row reads one index range of its runs; deleted Automations are skipped because no list shows them.
UPDATE "junior_automations"
SET ("last_run_at_ms", "last_run_status") = (
  SELECT "completed_at_ms", "status"
  FROM "junior_automation_runs"
  WHERE "junior_automation_runs"."automation_id" = "junior_automations"."id"
    AND "junior_automation_runs"."status" IN ('blocked', 'completed', 'failed')
    AND "junior_automation_runs"."completed_at_ms" IS NOT NULL
  ORDER BY "completed_at_ms" DESC, "id" DESC
  LIMIT 1
)
WHERE "status" <> 'deleted';
