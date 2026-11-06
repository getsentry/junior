ALTER TABLE "junior_conversations" ADD COLUMN "kind" text;--> statement-breakpoint
-- Every existing child is a Task.
UPDATE "junior_conversations"
SET "kind" = CASE
  WHEN "parent_conversation_id" IS NULL THEN 'root'
  ELSE 'task'
END
WHERE "kind" IS NULL;
