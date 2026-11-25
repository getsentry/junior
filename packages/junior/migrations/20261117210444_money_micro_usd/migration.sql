ALTER TABLE "junior_conversation_briefs" ADD COLUMN "cost_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "junior_stats" ADD COLUMN "value" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Money in Postgres is whole micro-USD. The runtime before this release writes
-- `cost_usd` until its rollout ends; a later repair migration converts those
-- rows, and the release after it drops the column.
-- junior:bounded-backfill: Brief versions are append-only, so no app write changes these rows; only a cascade delete of a Conversation waits.
UPDATE "junior_conversation_briefs"
SET "cost_micro_usd" = round("cost_usd" * 1000000)::bigint
WHERE "cost_usd" IS NOT NULL;--> statement-breakpoint
-- Counters move to the bigint `value`, so a micro-USD counter does not
-- overflow int4. Cache warming dollar counters stored 1/10,000 USD units, so
-- 100 micro-USD each. `count` goes to 0, so the repair migration can move the
-- amounts that the runtime before this release adds to it during the rollout.
-- junior:bounded-backfill: the table holds a few hundred counters per day and runs last, so app counter writes wait only for one short update.
UPDATE "junior_stats"
SET
  "metric" = CASE
    WHEN "namespace" = 'cache_warming'
      AND "metric" IN ('oracle_savings', 'saved', 'unwarmed_oracle_savings', 'warmup_cost')
      THEN "metric" || '_micro_usd'
    ELSE "metric"
  END,
  "value" = CASE
    WHEN "namespace" = 'cache_warming'
      AND "metric" IN ('oracle_savings', 'saved', 'unwarmed_oracle_savings', 'warmup_cost')
      THEN "count"::bigint * 100
    ELSE "count"
  END,
  "count" = 0;
