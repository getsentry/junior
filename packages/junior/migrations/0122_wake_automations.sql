-- A wake Automation (a Snooze) brings an Inbox row back and runs no Turn.
-- It has a subject instead of a Slack Destination, so the three Slack
-- columns become nullable, and the checks branch on the new `action`.
ALTER TABLE "junior_automations" DROP CONSTRAINT "junior_automations_task_check";--> statement-breakpoint
ALTER TABLE "junior_automations" DROP CONSTRAINT "junior_automations_trigger_check";--> statement-breakpoint
ALTER TABLE "junior_automations" ALTER COLUMN "team_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_automations" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_automations" ALTER COLUMN "creator_slack_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_automations" ADD COLUMN "action" text DEFAULT 'run' NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_automations" ADD COLUMN "subject_conversation_id" text;--> statement-breakpoint
ALTER TABLE "junior_automations" ADD COLUMN "subject_review_item_id" text;--> statement-breakpoint
-- Every existing row is a run row with all Slack columns and no subject, so
-- every row passes the new checks and foreign keys. NOT VALID skips the scan
-- under lock and still checks every new write. A later migration validates
-- them.
ALTER TABLE "junior_automations" ADD CONSTRAINT "junior_automations_subject_conversation_fk" FOREIGN KEY ("subject_conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_automations" ADD CONSTRAINT "junior_automations_subject_review_item_fk" FOREIGN KEY ("subject_review_item_id") REFERENCES "public"."junior_review_items"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_automations" ADD CONSTRAINT "junior_automations_action_check" CHECK ("junior_automations"."action" in ('run', 'wake')) NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_automations" ADD CONSTRAINT "junior_automations_destination_check" CHECK (("junior_automations"."action" = 'run' and "junior_automations"."team_id" is not null and "junior_automations"."channel_id" is not null and "junior_automations"."creator_slack_user_id" is not null and "junior_automations"."subject_conversation_id" is null and "junior_automations"."subject_review_item_id" is null) or ("junior_automations"."action" = 'wake' and "junior_automations"."team_id" is null and "junior_automations"."channel_id" is null and "junior_automations"."creator_slack_user_id" is null and "junior_automations"."subject_conversation_id" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_automations" ADD CONSTRAINT "junior_automations_task_check" CHECK (("junior_automations"."action" = 'wake' and "junior_automations"."instruction" is null and "junior_automations"."skill" is null) or ("junior_automations"."action" = 'run' and ("junior_automations"."instruction" is null) <> ("junior_automations"."skill" is null))) NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_automations" ADD CONSTRAINT "junior_automations_trigger_check" CHECK (("junior_automations"."kind" = 'scheduled' and "junior_automations"."namespace" is null and "junior_automations"."identifier" is null) or ("junior_automations"."kind" = 'event' and "junior_automations"."namespace" is not null and "junior_automations"."run_now_at_ms" is null and ("junior_automations"."action" = 'wake' or ("junior_automations"."next_run_at_ms" is null and "junior_automations"."status" <> 'completed')))) NOT VALID;
