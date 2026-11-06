ALTER TABLE "junior_conversations" ADD COLUMN "kind" text;--> statement-breakpoint
-- Every existing child is a Task.
UPDATE "junior_conversations"
SET "kind" = CASE
  WHEN "parent_conversation_id" IS NULL THEN 'root'
  ELSE 'task'
END
WHERE "kind" IS NULL;--> statement-breakpoint
-- Validate after the backfill.
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_kind_check" CHECK ("junior_conversations"."kind" in ('root', 'thread', 'task'));--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_kind_parent_check" CHECK ("junior_conversations"."kind" is null or (("junior_conversations"."kind" = 'root') = ("junior_conversations"."parent_conversation_id" is null)));
