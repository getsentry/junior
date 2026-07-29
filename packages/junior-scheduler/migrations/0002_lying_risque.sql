ALTER TABLE "junior_scheduler_tasks" ADD COLUMN "creator_slack_user_id" text;--> statement-breakpoint
UPDATE "junior_scheduler_tasks"
SET "creator_slack_user_id" = "record"->'createdBy'->>'slackUserId';--> statement-breakpoint
CREATE INDEX "junior_scheduler_tasks_creator_idx" ON "junior_scheduler_tasks" USING btree ("team_id","creator_slack_user_id","created_at_ms","id") WHERE "junior_scheduler_tasks"."status" <> 'deleted';
