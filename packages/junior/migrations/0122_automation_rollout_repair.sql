-- While 0117 rolled out, the previous runtime still settled runs. It did not
-- copy run cost or move last_run_id, so those runs show no cost and their
-- Automations show an older last run. This recomputes both for runs that ended
-- after 1794933607046, when 0117 was written. No deploy ran 0117 before then,
-- so the window covers the whole rollout. Rows that already match are skipped,
-- so a second run changes nothing.
-- junior:bounded-backfill: runs that ended since 0117 was written, found through the completed index; each row reads its own Conversation by primary key, and rows that already match are not updated.
UPDATE "junior_automation_runs"
SET "cost_micro_usd" = "repair"."cost_micro_usd"
FROM (
  SELECT "run"."id", round(CASE
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
  END * 1000000)::bigint AS "cost_micro_usd"
  FROM "junior_automation_runs" AS "run"
  JOIN "junior_conversations"
    ON "junior_conversations"."conversation_id" = "run"."conversation_id"
  WHERE "run"."completed_at_ms" >= 1794933607046
    AND "run"."status" IN ('blocked', 'completed', 'failed', 'skipped')
) AS "repair"
WHERE "junior_automation_runs"."id" = "repair"."id"
  AND "junior_automation_runs"."cost_micro_usd" IS DISTINCT FROM "repair"."cost_micro_usd";--> statement-breakpoint
-- junior:bounded-backfill: Automations with a run that ended since 0117 was written; each row reads one index range of its runs, and rows that already match are not updated.
UPDATE "junior_automations"
SET "last_run_id" = "repair"."last_run_id"
FROM (
  SELECT "automation"."id", (
    SELECT "run"."id"
    FROM "junior_automation_runs" AS "run"
    WHERE "run"."automation_id" = "automation"."id"
      AND "run"."status" IN ('blocked', 'completed', 'failed')
      AND "run"."completed_at_ms" IS NOT NULL
    ORDER BY "run"."completed_at_ms" DESC, "run"."id" DESC
    LIMIT 1
  ) AS "last_run_id"
  FROM "junior_automations" AS "automation"
  WHERE "automation"."status" <> 'deleted'
    AND "automation"."id" IN (
      SELECT "automation_id"
      FROM "junior_automation_runs"
      WHERE "completed_at_ms" >= 1794933607046
    )
) AS "repair"
WHERE "junior_automations"."id" = "repair"."id"
  AND "junior_automations"."last_run_id" IS DISTINCT FROM "repair"."last_run_id";
