-- Archive now applies to everyone and lives on junior_conversations. Its
-- legacy archived_at values are stale, so clear them first.
UPDATE "junior_conversations" SET "archived_at" = NULL WHERE "archived_at" IS NOT NULL;--> statement-breakpoint
-- A root stays archived only when every member archived it. The root actor
-- is a member without a participant row, and an archive always wrote one, so
-- an actor with no row did not archive it.
UPDATE "junior_conversations" AS "c"
SET "archived_at" = "p"."archived_at"
FROM (
  SELECT "root_conversation_id", max("archived_at") AS "archived_at"
  FROM "junior_conversation_participants"
  GROUP BY "root_conversation_id"
  HAVING count(*) = count("archived_at")
) AS "p"
WHERE "c"."conversation_id" = "p"."root_conversation_id"
  AND "c"."parent_conversation_id" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "junior_identities" AS "i"
    WHERE "i"."id" = "c"."actor_identity_id"
      AND "i"."user_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "junior_conversation_participants" AS "ap"
        WHERE "ap"."root_conversation_id" = "c"."conversation_id"
          AND "ap"."user_id" = "i"."user_id"
      )
  );--> statement-breakpoint
-- A child archive was already shared.
UPDATE "junior_conversations" SET "archived_at" = "child_archived_at" WHERE "child_archived_at" IS NOT NULL;--> statement-breakpoint
DROP INDEX "junior_conversation_participants_unarchived_activity_idx";--> statement-breakpoint
DROP INDEX "junior_conversation_participants_auto_archive_idx";--> statement-breakpoint
CREATE INDEX "junior_conversation_participants_auto_archive_idx" ON "junior_conversation_participants" USING btree ("user_id") WHERE "junior_conversation_participants"."auto_archive";
