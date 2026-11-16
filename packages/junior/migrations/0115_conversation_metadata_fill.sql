-- Copy the latest Brief of each Conversation into its Conversation metadata,
-- and point the Conversation embedding of that Brief at the copied metadata.
-- Purge already deleted the Briefs of purged private Conversations. A Brief
-- that an older worker stores during the rollout is not copied; the next
-- Turn of that Conversation writes its metadata.
-- junior:bounded-backfill: runs once and changes each Conversation that has a Brief once. Most of these Conversations are idle, and the update sets only new columns.
WITH "latest" AS (
  SELECT DISTINCT ON ("conversation_id")
    "conversation_id",
    "version",
    "through_seq",
    "content"
  FROM "junior_conversation_briefs"
  ORDER BY "conversation_id", "version" DESC
)
UPDATE "junior_conversations" AS "conversations"
SET
  "summary" = "latest"."content"->>'summary',
  "metadata_through_seq" = "latest"."through_seq",
  "detail_version" = "conversations"."detail_version" + 1
FROM "latest"
WHERE "latest"."conversation_id" = "conversations"."conversation_id"
  AND "conversations"."metadata_through_seq" IS NULL;
--> statement-breakpoint
-- junior:bounded-backfill: only the metadata task writes Conversation embeddings, and the update sets only a new column.
WITH "latest" AS (
  SELECT DISTINCT ON ("conversation_id")
    "conversation_id",
    "version",
    "through_seq"
  FROM "junior_conversation_briefs"
  ORDER BY "conversation_id", "version" DESC
)
UPDATE "junior_conversation_embeddings" AS "embeddings"
SET "through_seq" = "latest"."through_seq"
FROM "latest"
WHERE "latest"."conversation_id" = "embeddings"."conversation_id"
  AND "latest"."version" = "embeddings"."brief_version"
  AND "embeddings"."through_seq" IS NULL;
