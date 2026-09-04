ALTER TABLE "junior_attachments" ADD COLUMN "slack_file_id" text;--> statement-breakpoint
ALTER TABLE "junior_attachments" ADD COLUMN "vision_summary" text;--> statement-breakpoint
CREATE INDEX "junior_attachments_slack_file_idx" ON "junior_attachments" USING btree ("conversation_id","slack_file_id");