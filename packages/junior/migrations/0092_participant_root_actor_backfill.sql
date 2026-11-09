-- Access and feeds read only Participant rows. Add the root Actor of each
-- root whose Identity got its User after the root was written.
INSERT INTO "junior_conversation_participants" (
  "user_id",
  "root_conversation_id",
  "last_message_at"
)
SELECT
  i."user_id",
  c."conversation_id",
  c."last_activity_at"
FROM "junior_conversations" AS c
INNER JOIN "junior_identities" AS i
  ON i."id" = c."actor_identity_id"
WHERE c."parent_conversation_id" IS NULL
  AND i."user_id" IS NOT NULL
  AND i."kind" = 'user'
ON CONFLICT ("user_id", "root_conversation_id") DO NOTHING;
