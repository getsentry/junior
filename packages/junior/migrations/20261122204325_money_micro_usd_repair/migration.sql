-- While 0119 and 0120 rolled out, the runtime before micro-USD still wrote
-- money in the old units. This converts those rows. Each statement changes
-- only old-unit rows, and the statements remove them, so a second run changes
-- nothing.
--
-- Convert each old cost row; when the new runtime also wrote the Run, the
-- later row wins. A Conversation with an old cost row got a usage cost from
-- one runtime that did not see the other runtime's rows, so sum each Run's
-- latest cost row into its usage cost again, and copy it to the Conversation's
-- Automation runs, as costMicroUsdExpr does for a usage cost with only a total.
-- The metrics table is large and has no index on 'cost_usd', so one statement
-- scans it once. Every CTE reads the rows from before the statement, so
-- "run_costs" still sees the old rows that "old" deletes.
-- junior:bounded-backfill: changes only old cost rows and the Conversations and runs that have one, which the old runtime wrote during one rollout, so few rows match; the reads by Conversation use the primary key.
WITH "old" AS (
  DELETE FROM "junior_conversation_metrics"
  WHERE "metric" = 'cost_usd'
  RETURNING "conversation_id", "run_id", "actor_identity_id", "value", "occurred_at", "updated_at"
),
"converted" AS (
  INSERT INTO "junior_conversation_metrics"
    ("conversation_id", "run_id", "metric", "actor_identity_id", "value", "occurred_at", "updated_at")
  SELECT "conversation_id", "run_id", 'cost_micro_usd', "actor_identity_id", round("value" * 1000000), "occurred_at", "updated_at"
  FROM "old"
  ON CONFLICT ("conversation_id", "run_id", "metric") DO UPDATE
  SET "value" = excluded."value", "updated_at" = excluded."updated_at"
  WHERE "junior_conversation_metrics"."updated_at" < excluded."updated_at"
),
"run_costs" AS (
  SELECT DISTINCT ON ("m"."conversation_id", "m"."run_id")
    "m"."conversation_id",
    CASE
      WHEN "m"."metric" = 'cost_usd' THEN round("m"."value" * 1000000)
      ELSE "m"."value"
    END AS "micro_usd"
  FROM "junior_conversation_metrics" AS "m"
  WHERE "m"."conversation_id" IN (SELECT "conversation_id" FROM "old")
    AND "m"."metric" IN ('cost_usd', 'cost_micro_usd')
  ORDER BY "m"."conversation_id", "m"."run_id", "m"."updated_at" DESC
),
"totals" AS (
  SELECT "conversation_id", sum("micro_usd") AS "micro_usd"
  FROM "run_costs"
  GROUP BY "conversation_id"
),
"repaired" AS (
  UPDATE "junior_conversations" AS "c"
  SET
    "usage_json" = jsonb_set(
      coalesce("c"."usage_json", '{}'::jsonb),
      '{cost}',
      jsonb_build_object('total', "t"."micro_usd" / 1000000.0::double precision)
    ),
    "detail_version" = "c"."detail_version" + 1
  FROM "totals" AS "t"
  WHERE "c"."conversation_id" = "t"."conversation_id"
  RETURNING "c"."conversation_id", "c"."usage_json"
)
UPDATE "junior_automation_runs" AS "r"
SET "cost_micro_usd" = round(("c"."usage_json"->'cost'->>'total')::double precision * 1000000)::bigint
FROM "repaired" AS "c"
WHERE "c"."conversation_id" = "r"."conversation_id";--> statement-breakpoint
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
