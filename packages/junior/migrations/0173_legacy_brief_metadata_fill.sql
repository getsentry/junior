-- The snapshot no longer has junior_conversation_briefs or
-- junior_conversation_embeddings.brief_version. They stay in the database for
-- one release, because old workers still read the Briefs for status and name
-- brief_version in every embedding insert while this migration runs. The next
-- release drops them with DROP ... IF EXISTS, as 0165 does.
--
-- Repeat the summary copy of 0150_conversation_metadata_fill. Workers before
-- #3486 could still store a Brief after 0150 ran, so a Conversation with no
-- later Turn has a Brief but no metadata.
-- junior:bounded-backfill: changes only Conversations whose latest Brief an old worker stored during the 0150 rollout and that had no Turn since, so few rows match; the update sets only metadata columns.
WITH "latest" AS (
  SELECT DISTINCT ON ("conversation_id")
    "conversation_id",
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
