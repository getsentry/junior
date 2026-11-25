-- Access now reads visibility from each Conversation row instead of its
-- root's Destination. Copy the Destination value to each root, then the
-- root value to each child. Direct and private Destinations are private. A
-- root with no Destination, or one whose visibility is unknown, stays null,
-- which reads as private. This runs in its own transaction, after the one
-- that adds the column, so it holds no table lock that blocks reads.
-- junior:bounded-backfill: runs once and sets only the new column of each row once. Most Conversations are idle.
UPDATE "junior_conversations" AS "conversations"
SET "visibility" = CASE
  WHEN "destinations"."visibility" = 'public' THEN 'public'
  ELSE 'private'
END
FROM "junior_destinations" AS "destinations"
WHERE "destinations"."id" = "conversations"."destination_id"
  AND "conversations"."parent_conversation_id" IS NULL
  AND "destinations"."visibility" <> 'unknown'
  AND "conversations"."visibility" IS NULL;--> statement-breakpoint
-- junior:bounded-backfill: runs once and sets only the new column of each child once, from its root.
UPDATE "junior_conversations" AS "children"
SET "visibility" = "roots"."visibility"
FROM "junior_conversations" AS "roots"
WHERE "roots"."conversation_id" = "children"."root_conversation_id"
  AND "children"."parent_conversation_id" IS NOT NULL
  AND "roots"."visibility" IS NOT NULL
  AND "children"."visibility" IS NULL;
