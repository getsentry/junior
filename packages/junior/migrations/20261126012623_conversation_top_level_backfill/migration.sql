-- Before Spaces had Lead children, every tree root was also its top-level
-- Conversation. This runs in its own transaction, after the one that adds
-- the column, so it holds no table lock that blocks reads.
-- junior:bounded-backfill: runs once and sets only the new column of each row once. Most Conversations are idle.
UPDATE "junior_conversations"
SET "top_level_conversation_id" = coalesce("root_conversation_id", "conversation_id")
WHERE "top_level_conversation_id" IS NULL;
