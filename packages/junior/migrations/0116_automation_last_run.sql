ALTER TABLE "junior_automation_runs" ADD COLUMN "cost_usd" double precision;--> statement-breakpoint
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
WHERE "status" <> 'deleted';--> statement-breakpoint
-- Automation cost totals sum this column. Each usage write of a Conversation
-- copies its cost to its run, and each run write copies it when it links the
-- Conversation. This matches conversationUsageCostExpr.
-- junior:bounded-backfill: settled runs only, which no app write changes; each row reads its own Conversation by primary key.
UPDATE "junior_automation_runs"
SET "cost_usd" = (
  SELECT CASE
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
  END
  FROM "junior_conversations"
  WHERE "junior_conversations"."conversation_id" = "junior_automation_runs"."conversation_id"
)
WHERE "conversation_id" IS NOT NULL
  AND "status" IN ('blocked', 'completed', 'failed', 'skipped');
