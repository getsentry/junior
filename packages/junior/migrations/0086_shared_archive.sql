-- Archive now applies to everyone and lives on junior_conversations. Its
-- legacy archived_at values are stale, so clear them first.
UPDATE "junior_conversations" SET "archived_at" = NULL WHERE "archived_at" IS NOT NULL;--> statement-breakpoint
-- A root stays archived only when every participant archived it.
UPDATE "junior_conversations" AS "c"
SET "archived_at" = "p"."archived_at"
FROM (
  SELECT "root_conversation_id", max("archived_at") AS "archived_at"
  FROM "junior_conversation_participants"
  GROUP BY "root_conversation_id"
  HAVING count(*) = count("archived_at")
) AS "p"
WHERE "c"."conversation_id" = "p"."root_conversation_id"
  AND "c"."parent_conversation_id" IS NULL;--> statement-breakpoint
-- A child archive was already shared.
UPDATE "junior_conversations" SET "archived_at" = "child_archived_at" WHERE "child_archived_at" IS NOT NULL;--> statement-breakpoint
DROP INDEX "junior_conversation_participants_unarchived_activity_idx";--> statement-breakpoint
DROP INDEX "junior_conversation_participants_auto_archive_idx";--> statement-breakpoint
CREATE INDEX "junior_conversation_participants_auto_archive_idx" ON "junior_conversation_participants" USING btree ("user_id") WHERE "junior_conversation_participants"."auto_archive";--> statement-breakpoint
ALTER TABLE "junior_conversations" DROP COLUMN "child_archived_at";
