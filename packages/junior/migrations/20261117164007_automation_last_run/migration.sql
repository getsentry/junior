ALTER TABLE "junior_automation_runs" ADD COLUMN "cost_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "junior_automations" ADD COLUMN "last_run_id" text;--> statement-breakpoint
-- Every row has a null last_run_id here. NOT VALID skips the scan under lock
-- and still checks every new write.
ALTER TABLE "junior_automations" ADD CONSTRAINT "junior_automations_last_run_id_junior_automation_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."junior_automation_runs"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
-- The list orders by the end of this run and finds failed last runs through
-- it, and each new run write refreshes it. A run that the old runtime writes
-- during the rollout leaves an older run until that Automation runs again.
-- junior:bounded-backfill: one row per listed Automation, and each row reads one index range of its runs; deleted Automations are skipped because no list shows them.
UPDATE "junior_automations"
SET "last_run_id" = (
  SELECT "id"
  FROM "junior_automation_runs"
  WHERE "junior_automation_runs"."automation_id" = "junior_automations"."id"
    AND "junior_automation_runs"."status" IN ('blocked', 'completed', 'failed')
    AND "junior_automation_runs"."completed_at_ms" IS NOT NULL
  ORDER BY "completed_at_ms" DESC, "id" DESC
  LIMIT 1
)
WHERE "status" <> 'deleted';--> statement-breakpoint
-- Automation cost totals sum this column, in micro-USD. Each usage write of a
-- Conversation copies its cost to its run, and each run write copies it when
-- it links the Conversation. This matches costMicroUsdExpr.
-- junior:bounded-backfill: settled runs only, which no app write changes; each row reads its own Conversation by primary key.
UPDATE "junior_automation_runs"
SET "cost_micro_usd" = (
  SELECT round(CASE
    WHEN "usage_json"->'cost'->>'total' IS NOT NULL
      THEN ("usage_json"->'cost'->>'total')::double precision
    WHEN COALESCE(
      "usage_json"->'cost'->>'input',
      "usage_json"->'cost'->>'output',
      "usage_json"->'cost'->>'cacheRead',
      "usage_json"->'cost'->>'cacheWrite'
    ) IS NOT NULL
      THEN COALESCE(("usage_json"->'cost'->>'input')::double precision, 0)
        + COALESCE(("usage_json"->'cost'->>'output')::double precision, 0)
        + COALESCE(("usage_json"->'cost'->>'cacheRead')::double precision, 0)
        + COALESCE(("usage_json"->'cost'->>'cacheWrite')::double precision, 0)
    ELSE NULL
  END * 1000000)::bigint
  FROM "junior_conversations"
  WHERE "junior_conversations"."conversation_id" = "junior_automation_runs"."conversation_id"
)
WHERE "conversation_id" IS NOT NULL
  AND "status" IN ('blocked', 'completed', 'failed', 'skipped');
