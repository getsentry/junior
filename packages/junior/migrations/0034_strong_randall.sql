ALTER TABLE "junior_conversation_participants" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
INSERT INTO "junior_conversation_participants" (
  "user_id",
  "root_conversation_id",
  "last_message_at",
  "archived_at"
)
SELECT
  identity."user_id",
  conversation."conversation_id",
  conversation."last_activity_at",
  conversation."archived_at"
FROM "junior_conversations" AS conversation
INNER JOIN "junior_identities" AS identity
  ON identity."id" = conversation."actor_identity_id"
WHERE conversation."parent_conversation_id" IS NULL
  AND conversation."archived_at" IS NOT NULL
  AND identity."user_id" IS NOT NULL
  AND identity."kind" = 'user'
ON CONFLICT ("user_id", "root_conversation_id") DO UPDATE
SET
  "last_message_at" = greatest(
    "junior_conversation_participants"."last_message_at",
    excluded."last_message_at"
  ),
  "archived_at" = excluded."archived_at";--> statement-breakpoint
UPDATE "junior_conversation_participants" AS participant
SET "archived_at" = conversation."archived_at"
FROM "junior_conversations" AS conversation
WHERE conversation."conversation_id" = participant."root_conversation_id"
  AND conversation."archived_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_conversations" DROP COLUMN "archived_at";
