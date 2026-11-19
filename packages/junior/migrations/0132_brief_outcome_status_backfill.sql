-- Rows that the runtime before this release writes during the rollout keep a
-- null status, and readers fall back to the content. This runs in its own
-- transaction, after the one that adds the column, so it holds no table lock
-- that blocks Brief reads or new Brief versions.
-- junior:bounded-backfill: Brief versions are append-only, so no app write changes these rows; only a cascade delete of a Conversation waits.
UPDATE "junior_conversation_briefs"
SET "outcome_status" = "content"->'outcome'->>'status';
