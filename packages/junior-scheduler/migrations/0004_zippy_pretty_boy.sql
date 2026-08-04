ALTER TABLE "junior_scheduler_tasks" ADD COLUMN "creator_identity_id" text;--> statement-breakpoint
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
		$sql$;
	END IF;
END
$migration$;--> statement-breakpoint
-- TODO(v0.128.0): Drop this trigger with the legacy Slack creator column.
CREATE OR REPLACE FUNCTION "junior_scheduler_assign_creator_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
	resolved_identity_id text;
BEGIN
	IF NEW."creator_identity_id" IS NOT NULL
		OR NEW."creator_slack_user_id" IS NULL
		OR to_regclass('public.junior_identities') IS NULL THEN
		RETURN NEW;
	END IF;

	EXECUTE $sql$
		INSERT INTO "junior_identities" (
			"id",
			"kind",
			"provider",
			"provider_tenant_id",
			"provider_subject_id",
			"created_at",
			"updated_at"
		) VALUES (
			'scheduler-slack-' || md5($1 || ':' || $2),
			'user',
			'slack',
			$1,
			$2,
			to_timestamp($3 / 1000.0),
			CURRENT_TIMESTAMP
		)
		ON CONFLICT ("provider", "provider_tenant_id", "provider_subject_id") DO NOTHING
	$sql$ USING NEW."team_id", NEW."creator_slack_user_id", NEW."created_at_ms";

	EXECUTE $sql$
		SELECT "id"
		FROM "junior_identities"
		WHERE "kind" = 'user'
			AND "provider" = 'slack'
			AND "provider_tenant_id" = $1
			AND "provider_subject_id" = $2
		LIMIT 1
	$sql$
	INTO resolved_identity_id
	USING NEW."team_id", NEW."creator_slack_user_id";

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
CREATE TRIGGER "junior_scheduler_assign_creator_identity"
BEFORE INSERT ON "junior_scheduler_tasks"
FOR EACH ROW
EXECUTE FUNCTION "junior_scheduler_assign_creator_identity"();--> statement-breakpoint
CREATE INDEX "junior_scheduler_tasks_creator_identity_idx" ON "junior_scheduler_tasks" USING btree ("creator_identity_id","created_at_ms","id") WHERE "junior_scheduler_tasks"."status" <> 'deleted' AND "junior_scheduler_tasks"."creator_identity_id" IS NOT NULL;
