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
-- Stop before the copy if a Scheduled automation and an event automation
-- have the same id.
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
-- Copy both old tables. Old workers still use them during the deploy, so they
-- stay. The copy keeps what the old readers read:
-- - A Scheduled automation takes its status and status reason from its JSON.
-- - A title and a creator identity come from the column, or else from the
--   legacy JSON key.
-- - A status that the new check does not allow becomes "deleted".
-- JSON keys that now have a column are removed from the record.
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
	coalesce("record"->'createdBy'->>'slackUserId', ''),
	"creator_identity_id",
	CASE
		WHEN "status" IN ('active', 'blocked', 'paused', 'completed', 'deleted') THEN "status"
		ELSE 'deleted'
	END,
	"status_reason",
	nullif(btrim(coalesce("title", "record"->>'title')), ''),
	coalesce("record"->'task'->>'text', ''),
	"created_at_ms",
	"next_run_at_ms",
	"run_now_at_ms",
	"namespace",
	"identifier",
	"record" - ARRAY['createdAtMs', 'creatorIdentityId', 'id', 'nextRunAtMs', 'runNowAtMs', 'status', 'statusReason', 'title', 'version']
FROM (
	SELECT
		'scheduled' AS "kind",
		"id",
		"team_id",
		coalesce("creator_identity_id", "record"->>'creatorIdentityId') AS "creator_identity_id",
		"record"->>'status' AS "status",
		"record"->>'statusReason' AS "status_reason",
		"title",
		"created_at_ms",
		"next_run_at_ms",
		"run_now_at_ms",
		NULL AS "namespace",
		NULL AS "identifier",
		"record"
	FROM "junior_scheduler_tasks"
	UNION ALL
	SELECT
		'event',
		"id",
		"team_id",
		NULL,
		"status",
		"status_reason",
		"title",
		"created_at_ms",
		NULL,
		NULL,
		"namespace",
		"identifier",
		"task_json"
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
-- Versions now key on the Automation id. Old workers still write kind during
-- the deploy, so kind stays as a nullable column until PR 3 of #2176.
ALTER TABLE "junior_automation_versions" DROP CONSTRAINT "junior_automation_versions_pk";
--> statement-breakpoint
ALTER TABLE "junior_automation_versions" ADD CONSTRAINT "junior_automation_versions_pk" PRIMARY KEY("automation_id","version");
--> statement-breakpoint
ALTER TABLE "junior_automation_versions" ALTER COLUMN "kind" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "junior_automation_versions" ADD CONSTRAINT "junior_automation_versions_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."junior_automations"("id") ON DELETE cascade ON UPDATE no action;