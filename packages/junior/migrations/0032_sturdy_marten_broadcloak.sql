ALTER TABLE "junior_conversation_participants" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
UPDATE "junior_conversation_participants" AS participant
SET "archived_at" = conversation."archived_at"
FROM "junior_conversations" AS conversation
WHERE conversation."conversation_id" = participant."root_conversation_id"
  AND conversation."archived_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_conversations" DROP COLUMN "archived_at";
