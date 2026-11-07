-- Unread now comes from read positions. Positions written before this
-- release moved when a conversation opened, so treat everything before the
-- release as read. Otherwise each conversation with a reply since its last
-- open would show in Needs attention at once.
UPDATE "junior_conversation_read_positions" AS "position"
SET "last_read_seq" = "latest"."seq"
FROM (
  SELECT "rp"."user_id", "rp"."conversation_id",
    (SELECT max("e"."seq") FROM "junior_conversation_events" AS "e"
      WHERE "e"."conversation_id" = "rp"."conversation_id") AS "seq"
  FROM "junior_conversation_read_positions" AS "rp"
) AS "latest"
WHERE "position"."user_id" = "latest"."user_id"
  AND "position"."conversation_id" = "latest"."conversation_id"
  AND "latest"."seq" > "position"."last_read_seq";
