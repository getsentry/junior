DROP INDEX "junior_scheduler_tasks_creator_idx";--> statement-breakpoint
ALTER TABLE "junior_scheduler_tasks" ADD COLUMN "creator_identity_id" text;--> statement-breakpoint
ALTER TABLE "junior_scheduler_tasks" ADD COLUMN "creator_user_id" text;--> statement-breakpoint
DO $migration$
BEGIN
	IF to_regclass('public.junior_identities') IS NOT NULL THEN
		EXECUTE $sql$
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
			ON CONFLICT ("provider", "provider_tenant_id", "provider_subject_id") DO NOTHING
		$sql$;

		EXECUTE $sql$
			UPDATE "junior_scheduler_tasks" AS task
			SET
				"creator_identity_id" = identity."id",
				"creator_user_id" = identity."user_id",
				"record" = CASE
					WHEN jsonb_typeof(task."record") = 'object' THEN
						task."record" || jsonb_strip_nulls(jsonb_build_object(
							'creatorIdentityId', identity."id",
							'creatorUserId', identity."user_id"
						))
					ELSE task."record"
				END
			FROM "junior_identities" AS identity
			WHERE identity."kind" = 'user'
				AND identity."provider" = 'slack'
				AND identity."provider_tenant_id" = task."team_id"
				AND identity."provider_subject_id" = task."creator_slack_user_id"
		$sql$;
	END IF;
END
$migration$;--> statement-breakpoint
CREATE INDEX "junior_scheduler_tasks_creator_user_idx" ON "junior_scheduler_tasks" USING btree ("creator_user_id","created_at_ms","id") WHERE "junior_scheduler_tasks"."status" <> 'deleted' AND "junior_scheduler_tasks"."creator_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "junior_scheduler_tasks_creator_identity_idx" ON "junior_scheduler_tasks" USING btree ("creator_identity_id","created_at_ms","id") WHERE "junior_scheduler_tasks"."status" <> 'deleted' AND "junior_scheduler_tasks"."creator_identity_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_scheduler_tasks" DROP COLUMN "creator_slack_user_id";
