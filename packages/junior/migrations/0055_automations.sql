CREATE TABLE "junior_automations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"creator_slack_user_id" text NOT NULL,
	"creator_identity_id" text,
	"status" text NOT NULL,
	"status_reason" text,
	"title" text,
	"instruction" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"next_run_at_ms" bigint,
	"run_now_at_ms" bigint,
	"namespace" text,
	"identifier" text,
	"record" jsonb NOT NULL,
	CONSTRAINT "junior_automations_kind_check" CHECK ("junior_automations"."kind" in ('scheduled', 'event')),
	CONSTRAINT "junior_automations_status_check" CHECK ("junior_automations"."status" in ('active', 'blocked', 'paused', 'completed', 'deleted')),
	CONSTRAINT "junior_automations_record_check" CHECK (jsonb_typeof("junior_automations"."record") = 'object'),
	CONSTRAINT "junior_automations_trigger_check" CHECK (("junior_automations"."kind" = 'scheduled' and "junior_automations"."namespace" is null and "junior_automations"."identifier" is null) or ("junior_automations"."kind" = 'event' and "junior_automations"."namespace" is not null and "junior_automations"."identifier" is not null and "junior_automations"."next_run_at_ms" is null and "junior_automations"."run_now_at_ms" is null and "junior_automations"."status" <> 'completed'))
);
--> statement-breakpoint
-- One id must name one Automation. Stop before any copy if a Scheduled
-- automation and an event automation share an id.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "junior_scheduler_tasks" AS "scheduled"
		JOIN "junior_event_tasks" AS "event" ON "event"."id" = "scheduled"."id"
	) THEN
		RAISE EXCEPTION 'junior_scheduler_tasks and junior_event_tasks share an Automation id';
	END IF;
END
$$;
--> statement-breakpoint
-- Copy both Automation tables. The old tables stay for workers that run
-- during the deploy. The copy applies the fallbacks that the old readers
-- applied, so current readers need none:
-- - Title and creator identity use the column, then the legacy JSON key.
-- - A Scheduled automation status comes from its JSON, as the old reader did.
-- - An unknown status becomes "deleted". The old reader could not parse it.
-- - A missing outcome list becomes one message to the Destination.
-- - Destinations lose threadTs.
-- - JSON keys that now have a column are removed.
INSERT INTO "junior_automations" (
	"id", "kind", "team_id", "channel_id", "creator_slack_user_id",
	"creator_identity_id", "status", "status_reason", "title", "instruction",
	"created_at_ms", "next_run_at_ms", "run_now_at_ms", "namespace",
	"identifier", "record"
)
SELECT
	"id",
	"kind",
	"team_id",
	coalesce("record"->'destination'->>'channelId', ''),
	coalesce("record"->'createdBy'->>'slackUserId', "creator_slack_user_id", ''),
	"creator_identity_id",
	CASE
		WHEN "status" IN ('active', 'blocked', 'paused', 'deleted') THEN "status"
		WHEN "status" = 'completed' AND "kind" = 'scheduled' THEN "status"
		ELSE 'deleted'
	END,
	"status_reason",
	nullif(btrim("title"), ''),
	coalesce("record"->'task'->>'text', ''),
	"created_at_ms",
	"next_run_at_ms",
	"run_now_at_ms",
	"namespace",
	"identifier",
	("record" - ARRAY['createdAtMs', 'creatorIdentityId', 'id', 'nextRunAtMs', 'runNowAtMs', 'status', 'statusReason', 'title', 'version'])
	|| CASE
		WHEN jsonb_typeof("record"->'destination') = 'object'
			THEN jsonb_build_object('destination', ("record"->'destination') - 'threadTs')
		ELSE '{}'::jsonb
	END
	|| CASE
		WHEN jsonb_typeof("record"->'outcomes') = 'array' THEN jsonb_build_object(
			'outcomes',
			coalesce(
				(
					SELECT jsonb_agg(
						CASE
							WHEN jsonb_typeof("outcome"->'destination') = 'object'
								THEN jsonb_set("outcome", '{destination}', ("outcome"->'destination') - 'threadTs', false)
							ELSE "outcome"
						END
						ORDER BY "ordinality"
					)
					FROM jsonb_array_elements("record"->'outcomes') WITH ORDINALITY AS "items"("outcome", "ordinality")
				),
				'[]'::jsonb
			)
		)
		WHEN NOT "record" ? 'outcomes' AND jsonb_typeof("record"->'destination') = 'object' THEN jsonb_build_object(
			'outcomes',
			jsonb_build_array(
				jsonb_build_object(
					'action', 'send_message',
					'destination', ("record"->'destination') - 'threadTs'
				)
			)
		)
		ELSE '{}'::jsonb
	END
FROM (
	SELECT
		'scheduled' AS "kind",
		"id",
		"team_id",
		"creator_slack_user_id",
		coalesce(
			"creator_identity_id",
			CASE WHEN jsonb_typeof("record"->'creatorIdentityId') = 'string' THEN "record"->>'creatorIdentityId' END
		) AS "creator_identity_id",
		"record"->>'status' AS "status",
		CASE WHEN jsonb_typeof("record"->'statusReason') = 'string' THEN "record"->>'statusReason' END AS "status_reason",
		CASE
			WHEN "title" IS NOT NULL THEN "title"
			WHEN jsonb_typeof("record"->'title') = 'string' THEN "record"->>'title'
		END AS "title",
		"created_at_ms",
		"next_run_at_ms",
		"run_now_at_ms",
		NULL::text AS "namespace",
		NULL::text AS "identifier",
		CASE WHEN jsonb_typeof("record") = 'object' THEN "record" ELSE '{}'::jsonb END AS "record"
	FROM "junior_scheduler_tasks"
	UNION ALL
	SELECT
		'event',
		"id",
		"team_id",
		NULL,
		NULL,
		"status",
		"status_reason",
		"title",
		"created_at_ms",
		NULL,
		NULL,
		"namespace",
		"identifier",
		CASE WHEN jsonb_typeof("task_json") = 'object' THEN "task_json" ELSE '{}'::jsonb END
	FROM "junior_event_tasks"
) AS "source";
--> statement-breakpoint
CREATE INDEX "junior_automations_team_idx" ON "junior_automations" USING btree ("team_id","created_at_ms","id") WHERE "junior_automations"."status" <> 'deleted';
--> statement-breakpoint
CREATE INDEX "junior_automations_creator_idx" ON "junior_automations" USING btree ("team_id","creator_slack_user_id","created_at_ms","id");
--> statement-breakpoint
CREATE INDEX "junior_automations_creator_identity_idx" ON "junior_automations" USING btree ("creator_identity_id","created_at_ms","id") WHERE "junior_automations"."creator_identity_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "junior_automations_run_now_due_idx" ON "junior_automations" USING btree ("run_now_at_ms","created_at_ms","id") WHERE "junior_automations"."status" = 'active' AND "junior_automations"."run_now_at_ms" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "junior_automations_next_run_due_idx" ON "junior_automations" USING btree ("next_run_at_ms","created_at_ms","id") WHERE "junior_automations"."status" = 'active' AND "junior_automations"."next_run_at_ms" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "junior_automations_match_idx" ON "junior_automations" USING btree ("namespace","identifier","created_at_ms","id") WHERE "junior_automations"."status" <> 'deleted';
--> statement-breakpoint
-- Versions name their Automation by id alone. Old workers still write kind
-- during the deploy, so it stays as a nullable column until a later release.
ALTER TABLE "junior_automation_versions" DROP CONSTRAINT "junior_automation_versions_pk";
--> statement-breakpoint
ALTER TABLE "junior_automation_versions" ADD CONSTRAINT "junior_automation_versions_pk" PRIMARY KEY("automation_id","version");
--> statement-breakpoint
ALTER TABLE "junior_automation_versions" ALTER COLUMN "kind" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "junior_automation_versions" ADD CONSTRAINT "junior_automation_versions_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."junior_automations"("id") ON DELETE cascade ON UPDATE no action;