-- While 0119 and 0120 rolled out, the runtime before micro-USD still wrote
-- money in the old units. This converts those rows. Each statement changes
-- only old-unit rows, and the statements remove them, so a second run changes
-- nothing.
--
-- The metrics table is large and has no index on 'cost_usd', so scan it once,
-- before this migration locks any row. Later statements read this small set.
CREATE TEMPORARY TABLE "money_repair_conversations" ON COMMIT DROP AS
SELECT DISTINCT "conversation_id"
FROM "junior_conversation_metrics"
WHERE "metric" = 'cost_usd';--> statement-breakpoint
-- A Conversation with an old `cost_usd` metric row got a usage cost from one
-- runtime that did not see the other runtime's rows. Sum each Run's latest
-- cost row, in micro-USD, into its usage cost again.
-- junior:bounded-backfill: changes only Conversations with an old cost row, which the old runtime wrote during one rollout, so few rows match; the metric reads use the primary key.
WITH "run_costs" AS (
  SELECT DISTINCT ON ("m"."conversation_id", "m"."run_id")
    "m"."conversation_id",
    CASE
      WHEN "m"."metric" = 'cost_usd' THEN round("m"."value" * 1000000)
      ELSE "m"."value"
    END AS "micro_usd"
  FROM "junior_conversation_metrics" AS "m"
  JOIN "money_repair_conversations" USING ("conversation_id")
  WHERE "m"."metric" IN ('cost_usd', 'cost_micro_usd')
  ORDER BY "m"."conversation_id", "m"."run_id", "m"."updated_at" DESC
),
"totals" AS (
  SELECT "conversation_id", sum("micro_usd") AS "micro_usd"
  FROM "run_costs"
  GROUP BY "conversation_id"
)
UPDATE "junior_conversations" AS "c"
SET
  "usage_json" = jsonb_set(
    coalesce("c"."usage_json", '{}'::jsonb),
    '{cost}',
    jsonb_build_object('total', "t"."micro_usd" / 1000000.0::double precision)
  ),
  "detail_version" = "c"."detail_version" + 1
FROM "totals" AS "t"
WHERE "c"."conversation_id" = "t"."conversation_id";--> statement-breakpoint
-- Copy the repaired cost to the Automation runs of those Conversations. This
-- matches costMicroUsdExpr for a usage cost with only a total.
-- junior:bounded-backfill: changes only runs of Conversations with an old cost row, so few rows match; each row reads its own Conversation by primary key.
UPDATE "junior_automation_runs" AS "r"
SET "cost_micro_usd" = round(("c"."usage_json"->'cost'->>'total')::double precision * 1000000)::bigint
FROM "junior_conversations" AS "c", "money_repair_conversations" AS "a"
WHERE "c"."conversation_id" = "r"."conversation_id"
  AND "a"."conversation_id" = "r"."conversation_id"
  AND "c"."usage_json"->'cost'->>'total' IS NOT NULL;--> statement-breakpoint
-- Convert each old cost row. When the new runtime also wrote the Run, the
-- later row wins.
-- junior:bounded-backfill: deletes only old cost rows, which the old runtime wrote during one rollout, so few rows match; it finds them through the primary key.
WITH "old" AS (
  DELETE FROM "junior_conversation_metrics" AS "m"
  USING "money_repair_conversations" AS "a"
  WHERE "m"."conversation_id" = "a"."conversation_id"
    AND "m"."metric" = 'cost_usd'
  RETURNING "m"."conversation_id", "m"."run_id", "m"."actor_identity_id", "m"."value", "m"."occurred_at", "m"."updated_at"
)
INSERT INTO "junior_conversation_metrics"
  ("conversation_id", "run_id", "metric", "actor_identity_id", "value", "occurred_at", "updated_at")
SELECT "conversation_id", "run_id", 'cost_micro_usd', "actor_identity_id", round("value" * 1000000), "occurred_at", "updated_at"
FROM "old"
ON CONFLICT ("conversation_id", "run_id", "metric") DO UPDATE
SET "value" = excluded."value", "updated_at" = excluded."updated_at"
WHERE "junior_conversation_metrics"."updated_at" < excluded."updated_at";--> statement-breakpoint
-- Brief versions that the old runtime appended have only a USD cost.
-- junior:bounded-backfill: changes only Brief versions that the old runtime appended during one rollout, so few rows match; Brief versions are append-only, so no app write waits.
UPDATE "junior_conversation_briefs"
SET "cost_micro_usd" = round("cost_usd" * 1000000)::bigint
WHERE "cost_micro_usd" IS NULL
  AND "cost_usd" IS NOT NULL;--> statement-breakpoint
-- The old runtime added to `count`, which 0119 set to 0. Add those amounts to
-- `value`, under the micro-USD name for cache warming dollar counters, which
-- stored 100 micro-USD per unit. Only the counters of the rollout days match,
-- and the app does not write those days now.
INSERT INTO "junior_stats" ("date", "namespace", "metric", "name", "value")
SELECT
  "date",
  "namespace",
  CASE
    WHEN "namespace" = 'cache_warming'
      AND "metric" IN ('oracle_savings', 'saved', 'unwarmed_oracle_savings', 'warmup_cost')
      THEN "metric" || '_micro_usd'
    ELSE "metric"
  END,
  "name",
  CASE
    WHEN "namespace" = 'cache_warming'
      AND "metric" IN ('oracle_savings', 'saved', 'unwarmed_oracle_savings', 'warmup_cost')
      THEN "count"::bigint * 100
    ELSE "count"
  END
FROM "junior_stats"
WHERE "count" <> 0
ON CONFLICT ("date", "namespace", "metric", "name") DO UPDATE
SET "value" = "junior_stats"."value" + excluded."value";--> statement-breakpoint
-- junior:bounded-backfill: changes only counters that the old runtime added to during one rollout, so few rows match; the app does not write those days now.
UPDATE "junior_stats" SET "count" = 0 WHERE "count" <> 0;--> statement-breakpoint
-- junior:bounded-backfill: deletes only cache warming counters under old names, which the old runtime wrote during one rollout, so few rows match.
DELETE FROM "junior_stats"
WHERE "namespace" = 'cache_warming'
  AND "metric" IN ('oracle_savings', 'saved', 'unwarmed_oracle_savings', 'warmup_cost');
