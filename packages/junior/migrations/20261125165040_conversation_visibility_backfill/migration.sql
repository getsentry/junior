-- Access now reads visibility from the root Conversation instead of its
-- Destination. Copy the Destination value to each root. Direct and private
-- Destinations are private. A root with no Destination, or one whose
-- visibility is unknown, stays null, which reads as private. This runs in
-- its own transaction, after the one that adds the column, so it holds no
-- table lock that blocks reads.
-- junior:bounded-backfill: runs once and sets only the new column of each root once. Most roots are idle, and child Conversations do not change.
UPDATE "junior_conversations" AS "conversations"
SET "visibility" = CASE
  WHEN "destinations"."visibility" = 'public' THEN 'public'
  ELSE 'private'
END
FROM "junior_destinations" AS "destinations"
WHERE "destinations"."id" = "conversations"."destination_id"
  AND "conversations"."parent_conversation_id" IS NULL
  AND "destinations"."visibility" <> 'unknown'
  AND "conversations"."visibility" IS NULL;
