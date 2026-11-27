-- Every child stores its root's visibility. A Space Conversation that moved
-- under its Lead keeps the value it had as a root, which can be null. Copy
-- the root's value to each child that has none. A child whose root has none
-- stays null, which reads as private, so the root's first value fills it.
-- junior:bounded-backfill: runs once and sets only the children that have no visibility, which few rows are.
UPDATE "junior_conversations" AS "children"
SET "visibility" = "roots"."visibility"
FROM "junior_conversations" AS "roots"
WHERE "roots"."conversation_id" = "children"."root_conversation_id"
  AND "children"."parent_conversation_id" IS NOT NULL
  AND "roots"."visibility" IS NOT NULL
  AND "children"."visibility" IS NULL;
