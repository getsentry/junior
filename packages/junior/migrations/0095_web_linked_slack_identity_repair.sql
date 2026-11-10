-- Before #3066, a dashboard post into a Slack thread copied the poster's
-- email onto the thread starter's Slack Identity when Slack had returned no
-- email for the starter. The copied email linked that Identity to the
-- poster's User, and the link made the poster a Participant of every root
-- that the Identity started.
--
-- An Identity is damaged when all of these are true:
-- - It is a Slack user Identity with a User and a verified email.
-- - The User's web Identity, with that same email, wrote an event in a
--   Conversation of a root that the Slack Identity started.
-- - No instruction that the Slack Identity sent in its own roots carries that
--   email in its Slack Actor. That Actor has the email from the Slack profile,
--   and Slack is the only source that may give a Slack Identity its email.
--
-- One statement repairs every table, so each part reads the same rows.
WITH "damaged" AS (
  SELECT DISTINCT "slack"."id" AS "identity_id", "slack"."user_id"
  FROM "junior_identities" AS "slack"
  INNER JOIN "junior_conversations" AS "root"
    ON "root"."actor_identity_id" = "slack"."id"
    AND "root"."parent_conversation_id" IS NULL
  INNER JOIN "junior_conversations" AS "c"
    ON "c"."root_conversation_id" = "root"."conversation_id"
    OR "c"."conversation_id" = "root"."conversation_id"
  INNER JOIN "junior_conversation_events" AS "posted"
    ON "posted"."conversation_id" = "c"."conversation_id"
  INNER JOIN "junior_identities" AS "web"
    ON "web"."id" = "posted"."actor_identity_id"
  WHERE "slack"."kind" = 'user'
    AND "slack"."provider" = 'slack'
    AND "slack"."user_id" IS NOT NULL
    AND "slack"."email_verified"
    AND "web"."kind" = 'user'
    AND "web"."provider" = 'junior'
    AND "web"."user_id" = "slack"."user_id"
    AND "web"."email_normalized" = "slack"."email_normalized"
    AND NOT EXISTS (
      SELECT 1
      FROM "junior_conversations" AS "own_root"
      INNER JOIN "junior_conversations" AS "own_c"
        ON "own_c"."root_conversation_id" = "own_root"."conversation_id"
        OR "own_c"."conversation_id" = "own_root"."conversation_id"
      INNER JOIN "junior_conversation_events" AS "own"
        ON "own"."conversation_id" = "own_c"."conversation_id"
      WHERE "own_root"."actor_identity_id" = "slack"."id"
        AND "own_root"."parent_conversation_id" IS NULL
        AND "own"."type" = 'user_message'
        AND "own"."payload"->'provenance'->>'authority' = 'instruction'
        AND "own"."payload"->'provenance'->'actor'->>'platform' = 'slack'
        AND "own"."payload"->'provenance'->'actor'->>'userId' = "slack"."provider_subject_id"
        AND lower(btrim("own"."payload"->'provenance'->'actor'->>'email')) = "slack"."email_normalized"
    )
),
-- Remove the Participant rows that the link added. Keep a row when the User
-- wrote in that root through another of their Identities.
"removed_participants" AS (
  DELETE FROM "junior_conversation_participants" AS "p"
  USING "damaged" AS "d", "junior_conversations" AS "root"
  WHERE "p"."user_id" = "d"."user_id"
    AND "p"."root_conversation_id" = "root"."conversation_id"
    AND "root"."actor_identity_id" = "d"."identity_id"
    AND "root"."parent_conversation_id" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "junior_conversations" AS "c"
      INNER JOIN "junior_conversation_events" AS "e"
        ON "e"."conversation_id" = "c"."conversation_id"
      INNER JOIN "junior_identities" AS "author"
        ON "author"."id" = "e"."actor_identity_id"
      WHERE ("c"."root_conversation_id" = "root"."conversation_id"
          OR "c"."conversation_id" = "root"."conversation_id")
        AND "author"."user_id" = "d"."user_id"
        AND "author"."id" NOT IN (SELECT "identity_id" FROM "damaged")
    )
),
-- The detail report of these roots shows the root Actor and Participants.
"touched_roots" AS (
  UPDATE "junior_conversations" AS "root"
  SET "detail_version" = "root"."detail_version" + 1
  FROM "damaged" AS "d"
  WHERE "root"."actor_identity_id" = "d"."identity_id"
    AND "root"."parent_conversation_id" IS NULL
)
-- Put the Identity back to its state before the link. Slack gave it no
-- email, so a later Slack Turn cannot link it again.
UPDATE "junior_identities" AS "i"
SET "user_id" = NULL,
  "email" = NULL,
  "email_normalized" = NULL,
  "email_verified" = false,
  "updated_at" = now()
FROM "damaged" AS "d"
WHERE "i"."id" = "d"."identity_id";
