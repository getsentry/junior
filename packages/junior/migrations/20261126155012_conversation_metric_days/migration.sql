CREATE TABLE "junior_conversation_metric_days" (
	"day" date NOT NULL,
	"actor_identity_id" text,
	"metric_rows" integer NOT NULL,
	"cost_micro_usd" bigint NOT NULL,
	CONSTRAINT "junior_conversation_metric_days_day_actor_unique" UNIQUE NULLS NOT DISTINCT("day","actor_identity_id")
);
--> statement-breakpoint
-- Add each change to a `duration_ms` or `cost_micro_usd` row to its day row,
-- in the transaction of the change, so a day row moves with its metric rows.
-- OLD is null on INSERT and NEW is null on DELETE, so the metric filter skips
-- them. An UPDATE that moves a row to another day or Identity changes two day
-- rows, in key order. The next migration fills the day rows from the metric
-- rows written before this trigger.
CREATE OR REPLACE FUNCTION "junior_conversation_metric_days_apply"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	INSERT INTO "junior_conversation_metric_days" AS "days"
		("day", "actor_identity_id", "metric_rows", "cost_micro_usd")
	SELECT
		("change"."occurred_at" AT TIME ZONE 'UTC')::date,
		"change"."actor_identity_id",
		sum("change"."sign")::integer,
		coalesce(sum("change"."sign" * "change"."value") FILTER (
			WHERE "change"."metric" = 'cost_micro_usd'
		), 0)::bigint
	FROM (VALUES
		(OLD."occurred_at", OLD."actor_identity_id", OLD."metric", OLD."value", -1),
		(NEW."occurred_at", NEW."actor_identity_id", NEW."metric", NEW."value", 1)
	) AS "change"("occurred_at", "actor_identity_id", "metric", "value", "sign")
	WHERE "change"."metric" IN ('duration_ms', 'cost_micro_usd')
	GROUP BY 1, 2
	ORDER BY 1, 2
	ON CONFLICT ("day", "actor_identity_id") DO UPDATE SET
		"metric_rows" = "days"."metric_rows" + excluded."metric_rows",
		"cost_micro_usd" = "days"."cost_micro_usd" + excluded."cost_micro_usd";
	RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER "junior_conversation_metric_days_apply" AFTER INSERT OR UPDATE OR DELETE ON "junior_conversation_metrics" FOR EACH ROW EXECUTE FUNCTION "junior_conversation_metric_days_apply"();
