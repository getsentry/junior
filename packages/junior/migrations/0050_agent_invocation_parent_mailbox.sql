ALTER TABLE "junior_agent_invocations" ADD COLUMN "parent_mailbox_status" text;--> statement-breakpoint
CREATE INDEX "junior_agent_invocations_parent_mailbox_idx" ON "junior_agent_invocations" USING btree ("parent_mailbox_status","terminal_at");--> statement-breakpoint
UPDATE "junior_agent_invocations" SET "status" = 'paused' WHERE "status" = 'awaiting_resume';--> statement-breakpoint
UPDATE "junior_agent_invocations" SET "parent_mailbox_status" = 'appended' WHERE "status" IN ('blocked', 'completed', 'failed') AND "parent_mailbox_status" IS NULL;
