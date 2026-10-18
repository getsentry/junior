-- Bind every Automation to the Junior identity that created it. Event rows
-- did not store an identity before. Use the Slack identity of the stored
-- creator, and add it when Junior has not seen that Slack user yet.
INSERT INTO "junior_identities" (
	"id",
	"kind",
	"provider",
	"provider_tenant_id",
	"provider_subject_id",
	"created_at",
	"updated_at"
)
SELECT DISTINCT ON (automation."team_id", automation."creator_slack_user_id")
	'automation-slack-' || md5(automation."team_id" || ':' || automation."creator_slack_user_id"),
	'user',
	'slack',
	automation."team_id",
	automation."creator_slack_user_id",
	to_timestamp(automation."created_at_ms" / 1000.0),
	CURRENT_TIMESTAMP
FROM "junior_automations" AS automation
WHERE automation."creator_identity_id" IS NULL
ORDER BY automation."team_id", automation."creator_slack_user_id", automation."created_at_ms"
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "junior_automations" AS automation
SET "creator_identity_id" = identity."id"
FROM "junior_identities" AS identity
WHERE automation."creator_identity_id" IS NULL
	AND identity."provider" = 'slack'
	AND identity."provider_tenant_id" = automation."team_id"
	AND identity."provider_subject_id" = automation."creator_slack_user_id";--> statement-breakpoint
DROP INDEX "junior_automations_creator_idx";--> statement-breakpoint
DROP INDEX "junior_automations_creator_identity_idx";--> statement-breakpoint
ALTER TABLE "junior_automations" ALTER COLUMN "creator_identity_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "junior_automations_creator_identity_idx" ON "junior_automations" USING btree ("creator_identity_id","created_at_ms","id");
