-- Unread now comes from read positions. Positions written before this
-- release moved when a conversation opened, and many roots have none. Read
-- every root in each user's feed to its last event, so nothing shows in
-- Needs attention at deploy. A root with no position after this is new.
INSERT INTO "junior_conversation_read_positions" ("user_id", "conversation_id", "last_read_seq", "updated_at")
SELECT "member"."user_id", "member"."conversation_id", "latest"."seq", now()
FROM (
  SELECT "p"."user_id", "p"."root_conversation_id" AS "conversation_id"
  FROM "junior_conversation_participants" AS "p"
  UNION
  SELECT "i"."user_id", "c"."conversation_id"
  FROM "junior_conversations" AS "c"
  INNER JOIN "junior_identities" AS "i" ON "i"."id" = "c"."actor_identity_id"
  WHERE "c"."root_conversation_id" IS NULL AND "i"."user_id" IS NOT NULL
) AS "member"
INNER JOIN LATERAL (
  SELECT max("e"."seq") AS "seq"
  FROM "junior_conversation_events" AS "e"
  WHERE "e"."conversation_id" = "member"."conversation_id"
) AS "latest" ON "latest"."seq" IS NOT NULL
ON CONFLICT ("user_id", "conversation_id") DO UPDATE
SET "last_read_seq" = greatest("junior_conversation_read_positions"."last_read_seq", excluded."last_read_seq"),
  "updated_at" = excluded."updated_at";
