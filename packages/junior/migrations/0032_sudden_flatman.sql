ALTER TABLE "junior_conversation_participants" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
UPDATE "junior_conversation_participants" AS p
SET "archived_at" = c."archived_at"
FROM "junior_conversations" AS c
WHERE c."conversation_id" = p."root_conversation_id"
  AND c."archived_at" IS NOT NULL;--> statement-breakpoint
UPDATE "junior_conversations"
SET "archived_at" = NULL
WHERE "archived_at" IS NOT NULL;
