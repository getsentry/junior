CREATE TABLE "junior_guardian_review_hours" (
	"hour" timestamp with time zone NOT NULL,
	"decision" text NOT NULL,
	"reviews" integer NOT NULL,
	"cost_micro_usd" bigint,
	CONSTRAINT "junior_guardian_review_hours_hour_decision_pk" PRIMARY KEY("hour","decision")
);
--> statement-breakpoint
-- Count the reviews that exist now. The runtime before this release does not
-- add to these counts, so reviews that it records during the rollout are not
-- counted. Stats read 90 days, so older reviews are not counted. The time range
-- uses the partial Guardian review index, so this reads only the reviews in the
-- range. It runs before the Brief column is added, so this migration holds
-- the Brief table lock only for a moment.
INSERT INTO "junior_guardian_review_hours" ("hour", "decision", "reviews", "cost_micro_usd")
SELECT
  date_trunc('hour', "created_at", 'UTC'),
  "payload"->>'decision',
  count(*)::integer,
  sum(round(("payload"->>'costUsd')::numeric * 1000000))
    FILTER (WHERE jsonb_typeof("payload"->'costUsd') = 'number')::bigint
FROM "junior_conversation_events"
WHERE "type" = 'guardian_action_reviewed'
  AND "created_at" >= now() - interval '91 days'
  AND "payload"->>'decision' IS NOT NULL
GROUP BY 1, 2;--> statement-breakpoint
ALTER TABLE "junior_conversation_briefs" ADD COLUMN "outcome_status" text;
