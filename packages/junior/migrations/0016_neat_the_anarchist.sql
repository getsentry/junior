-- Adopt the former scheduler plugin tables without copying or renaming data.
CREATE TABLE IF NOT EXISTS "junior_scheduler_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"status" text NOT NULL,
	"scheduled_for_ms" bigint NOT NULL,
	"record" jsonb NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "junior_scheduler_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"creator_slack_user_id" text,
	"creator_identity_id" text,
	"status" text NOT NULL,
	"next_run_at_ms" bigint,
	"run_now_at_ms" bigint,
	"created_at_ms" bigint NOT NULL,
	"record" jsonb NOT NULL
);--> statement-breakpoint
ALTER TABLE "junior_scheduler_tasks" ADD COLUMN IF NOT EXISTS "creator_slack_user_id" text;--> statement-breakpoint
ALTER TABLE "junior_scheduler_tasks" ADD COLUMN IF NOT EXISTS "creator_identity_id" text;--> statement-breakpoint
UPDATE "junior_scheduler_tasks"
SET "record" = ("record" - 'credentialSubject') || jsonb_build_object('credentialMode', 'system')
WHERE NOT ("record" ? 'credentialMode')
   OR "record" ? 'credentialSubject';--> statement-breakpoint
UPDATE "junior_scheduler_tasks"
SET "creator_slack_user_id" = "record"->'createdBy'->>'slackUserId'
WHERE "creator_slack_user_id" IS NULL;--> statement-breakpoint
UPDATE "junior_scheduler_tasks" AS "task"
SET "record" = jsonb_set(
	"task"."record",
	'{conversationAccess}',
	jsonb_build_object(
		'audience',
		CASE
			WHEN "task"."record"#>>'{conversationAccess,audience}' IN ('direct', 'group', 'channel')
				THEN "task"."record"#>>'{conversationAccess,audience}'
			WHEN "task"."record"#>>'{destination,channelId}' LIKE 'D%' THEN 'direct'
			WHEN "task"."record"#>>'{destination,channelId}' LIKE 'G%' THEN 'group'
			ELSE 'channel'
		END,
		'visibility',
		COALESCE("destination"."visibility", 'private')
	),
	true
)
FROM public."junior_destinations" AS "destination"
WHERE COALESCE("task"."record"#>>'{conversationAccess,visibility}', 'unknown') = 'unknown'
	AND "destination"."provider" = 'slack'
	AND "destination"."provider_tenant_id" = "task"."team_id"
	AND "destination"."provider_destination_id" = "task"."record"#>>'{destination,channelId}'
	AND "destination"."visibility" IN ('public', 'private');--> statement-breakpoint
UPDATE "junior_scheduler_tasks" AS "task"
SET "record" = jsonb_set(
	"task"."record",
	'{conversationAccess}',
	jsonb_build_object(
		'audience',
		CASE
			WHEN "task"."record"#>>'{conversationAccess,audience}' IN ('direct', 'group', 'channel')
				THEN "task"."record"#>>'{conversationAccess,audience}'
			WHEN "task"."record"#>>'{destination,channelId}' LIKE 'D%' THEN 'direct'
			WHEN "task"."record"#>>'{destination,channelId}' LIKE 'G%' THEN 'group'
			ELSE 'channel'
		END,
		'visibility',
		'private'
	),
	true
)
WHERE COALESCE("task"."record"#>>'{conversationAccess,visibility}', 'unknown') = 'unknown';--> statement-breakpoint
INSERT INTO "junior_identities" (
	"id",
	"kind",
	"provider",
	"provider_tenant_id",
	"provider_subject_id",
	"created_at",
	"updated_at"
)
SELECT DISTINCT ON (task."team_id", task."creator_slack_user_id")
	'scheduler-slack-' || md5(task."team_id" || ':' || task."creator_slack_user_id"),
	'user',
	'slack',
	task."team_id",
	task."creator_slack_user_id",
	to_timestamp(task."created_at_ms" / 1000.0),
	CURRENT_TIMESTAMP
FROM "junior_scheduler_tasks" AS task
WHERE task."creator_slack_user_id" IS NOT NULL
ORDER BY task."team_id", task."creator_slack_user_id", task."created_at_ms"
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "junior_scheduler_tasks" AS task
SET
	"creator_identity_id" = identity."id",
	"record" = CASE
		WHEN jsonb_typeof(task."record") = 'object' THEN
			task."record" || jsonb_build_object('creatorIdentityId', identity."id")
		ELSE task."record"
	END
FROM "junior_identities" AS identity
WHERE identity."kind" = 'user'
	AND identity."provider" = 'slack'
	AND identity."provider_tenant_id" = task."team_id"
	AND identity."provider_subject_id" = task."creator_slack_user_id"
	AND task."creator_identity_id" IS NULL;--> statement-breakpoint
-- Keep rolling old workers compatible until the legacy creator column is retired.
CREATE OR REPLACE FUNCTION "junior_scheduler_assign_creator_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
	resolved_identity_id text;
BEGIN
	IF NEW."creator_identity_id" IS NOT NULL
		OR NEW."creator_slack_user_id" IS NULL THEN
		RETURN NEW;
	END IF;

	INSERT INTO "junior_identities" (
		"id",
		"kind",
		"provider",
		"provider_tenant_id",
		"provider_subject_id",
		"created_at",
		"updated_at"
	) VALUES (
		'scheduler-slack-' || md5(NEW."team_id" || ':' || NEW."creator_slack_user_id"),
		'user',
		'slack',
		NEW."team_id",
		NEW."creator_slack_user_id",
		to_timestamp(NEW."created_at_ms" / 1000.0),
		CURRENT_TIMESTAMP
	)
	ON CONFLICT DO NOTHING;

	SELECT "id"
	INTO resolved_identity_id
	FROM "junior_identities"
	WHERE "kind" = 'user'
		AND "provider" = 'slack'
		AND "provider_tenant_id" = NEW."team_id"
		AND "provider_subject_id" = NEW."creator_slack_user_id"
	LIMIT 1;

	IF resolved_identity_id IS NOT NULL THEN
		NEW."creator_identity_id" := resolved_identity_id;
		IF jsonb_typeof(NEW."record") = 'object' THEN
			NEW."record" := NEW."record" || jsonb_build_object(
				'creatorIdentityId',
				resolved_identity_id
			);
		END IF;
	END IF;
	RETURN NEW;
END
$function$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "junior_scheduler_assign_creator_identity" ON "junior_scheduler_tasks";--> statement-breakpoint
CREATE TRIGGER "junior_scheduler_assign_creator_identity"
BEFORE INSERT ON "junior_scheduler_tasks"
FOR EACH ROW
EXECUTE FUNCTION "junior_scheduler_assign_creator_identity"();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_scheduler_runs_task_status_idx" ON "junior_scheduler_runs" USING btree ("task_id","status","scheduled_for_ms");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_scheduler_runs_status_idx" ON "junior_scheduler_runs" USING btree ("status","scheduled_for_ms");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_scheduler_tasks_creator_idx" ON "junior_scheduler_tasks" USING btree ("team_id","creator_slack_user_id","created_at_ms","id") WHERE "junior_scheduler_tasks"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_scheduler_tasks_creator_identity_idx" ON "junior_scheduler_tasks" USING btree ("creator_identity_id","created_at_ms","id") WHERE "junior_scheduler_tasks"."status" <> 'deleted' AND "junior_scheduler_tasks"."creator_identity_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_scheduler_tasks_team_status_idx" ON "junior_scheduler_tasks" USING btree ("team_id","created_at_ms","id") WHERE "junior_scheduler_tasks"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_scheduler_tasks_run_now_due_idx" ON "junior_scheduler_tasks" USING btree ("run_now_at_ms","created_at_ms","id") WHERE "junior_scheduler_tasks"."status" = 'active' AND "junior_scheduler_tasks"."run_now_at_ms" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_scheduler_tasks_next_run_due_idx" ON "junior_scheduler_tasks" USING btree ("next_run_at_ms","created_at_ms","id") WHERE "junior_scheduler_tasks"."status" = 'active' AND "junior_scheduler_tasks"."next_run_at_ms" IS NOT NULL;
