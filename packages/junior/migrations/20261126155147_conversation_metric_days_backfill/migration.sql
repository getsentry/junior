-- Fill the day rows from the metric rows written before the trigger. The
-- trigger already adds new writes, so each day row is set from its metric
-- rows only while this migration holds the row lock:
--   1. Lock the day rows of one day, in key order, and create the missing
--      ones. A Turn write in flight finishes first; a later one waits for
--      this commit and then adds its change.
--   2. Set those rows from the metric rows, read after the locks.
-- A day row first written after step 1 has no older metric rows, so the
-- trigger alone keeps it right and this migration does not touch it.
-- Days run oldest first, so the days that Turns write to now stay locked
-- only for the last steps. Each day reads its metric rows by index.
DO $backfill$
DECLARE
	"backfill_day" date;
	"locked_identity_ids" text[];
BEGIN
	FOR "backfill_day" IN
		SELECT generate_series(
			(min("occurred_at") AT TIME ZONE 'UTC')::date,
			(max("occurred_at") AT TIME ZONE 'UTC')::date,
			interval '1 day'
		)::date
		FROM "junior_conversation_metrics"
	LOOP
		WITH "locked" AS (
			INSERT INTO "junior_conversation_metric_days" AS "days"
				("day", "actor_identity_id", "metric_rows", "cost_micro_usd")
			SELECT "backfill_day", "actor_identity_id", 0, 0
			FROM "junior_conversation_metrics"
			WHERE "metric" IN ('duration_ms', 'cost_micro_usd')
				AND "occurred_at" >= ("backfill_day"::timestamp AT TIME ZONE 'UTC')
				AND "occurred_at" < (("backfill_day" + 1)::timestamp AT TIME ZONE 'UTC')
			GROUP BY "actor_identity_id"
			ORDER BY "actor_identity_id"
			ON CONFLICT ("day", "actor_identity_id") DO UPDATE SET
				"metric_rows" = "days"."metric_rows"
			RETURNING "actor_identity_id"
		)
		SELECT array_agg("actor_identity_id") INTO "locked_identity_ids"
		FROM "locked";

		INSERT INTO "junior_conversation_metric_days" AS "days"
			("day", "actor_identity_id", "metric_rows", "cost_micro_usd")
		SELECT
			"backfill_day",
			"actor_identity_id",
			count(*)::integer,
			coalesce(sum("value") FILTER (WHERE "metric" = 'cost_micro_usd'), 0)::bigint
		FROM "junior_conversation_metrics"
		WHERE "metric" IN ('duration_ms', 'cost_micro_usd')
			AND "occurred_at" >= ("backfill_day"::timestamp AT TIME ZONE 'UTC')
			AND "occurred_at" < (("backfill_day" + 1)::timestamp AT TIME ZONE 'UTC')
			-- array_position also finds a null Identity.
			AND array_position("locked_identity_ids", "actor_identity_id") IS NOT NULL
		GROUP BY "actor_identity_id"
		ON CONFLICT ("day", "actor_identity_id") DO UPDATE SET
			"metric_rows" = excluded."metric_rows",
			"cost_micro_usd" = excluded."cost_micro_usd";
	END LOOP;
END
$backfill$;
