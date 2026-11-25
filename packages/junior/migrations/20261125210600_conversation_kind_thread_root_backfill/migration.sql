-- A Thread is now stored as a `root` with a parent. This runs in its own
-- transaction, after the one that changes the checks, so it holds no table
-- lock that blocks reads.
-- junior:bounded-backfill: runs once and sets only the kind of each Thread once. Threads are a small share of Conversations, and most are idle.
UPDATE "junior_conversations"
SET "kind" = 'root'
WHERE "kind" = 'thread';
