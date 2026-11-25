-- The `root` kind is now `thread`. This runs in its own transaction, after
-- the one that changes the checks, so it holds no table lock that blocks
-- reads.
-- junior:bounded-backfill: runs once and sets only the kind of each `root` row once. Most Conversations are idle.
UPDATE "junior_conversations"
SET "kind" = 'thread'
WHERE "kind" = 'root';
