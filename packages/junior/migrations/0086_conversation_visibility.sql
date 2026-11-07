ALTER TABLE "junior_conversations" ADD COLUMN "visibility" text;--> statement-breakpoint
-- Copy the known Destination value to each root Conversation. Destination
-- `public` is the company audience, so it becomes `internal`. No released
-- writer can make one Conversation at a shared Destination differ yet, so the
-- shared value is still correct for each of them.
UPDATE "junior_conversations" AS conversation
SET "visibility" = CASE destination."visibility"
  WHEN 'public' THEN 'internal'
  ELSE destination."visibility"
END
FROM "junior_destinations" AS destination
WHERE destination."id" = conversation."destination_id"
  AND conversation."parent_conversation_id" IS NULL
  AND destination."visibility" IN ('public', 'private', 'direct');--> statement-breakpoint
-- Validate after the backfill.
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_visibility_check" CHECK ("junior_conversations"."visibility" in ('direct', 'private', 'internal', 'world'));