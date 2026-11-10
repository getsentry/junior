-- Before #3066, a dashboard post into a Slack thread copied the poster's
-- email onto the thread starter's Slack Identity when Slack had returned no
-- email for the starter. The copied email linked that Identity to the
-- poster's User. The link made the poster a Participant of every root that
-- the Identity started or sent a Turn in.
--
-- Evidence: a Slack instruction stores the Actor from the Slack profile in
-- `provenance.actor`. Slack is the only source that may give a Slack Identity
-- its email, so an instruction with the Identity's Slack user and email
-- proves that email. Nothing else proves it.
--
-- A candidate is a Slack user Identity when all of these are true:
-- - It has a User and a verified email, and no evidence proves that email.
-- - The User's web Identity, with that same email, wrote an event in a
--   Conversation of a root that the Slack Identity started.
--
-- Slack emails are unique in a workspace, so one User has at most one
-- correct Slack Identity in each team. Repair a candidate only when evidence
-- proves exactly one other Slack Identity of its User in its team. Leave
-- every other candidate as it is. Without that proof, the data cannot tell a
-- victim from a person whose own link came through this path, or whose
-- events retention removed.
--
-- One statement repairs every table, so each part reads the same rows.
-- junior:bounded-backfill: changes only rows of damaged Identities, their Users, and the roots they started or sent Turns in. #3065 found few of these.
WITH "slack_evidence" AS (
  SELECT DISTINCT
    "e"."payload"->'provenance'->'actor'->>'userId' AS "subject",
    lower(btrim("e"."payload"->'provenance'->'actor'->>'email')) AS "email"
  FROM "junior_conversation_events" AS "e"
  WHERE "e"."type" = 'user_message'
    AND "e"."payload"->'provenance'->>'authority' = 'instruction'
    AND "e"."payload"->'provenance'->'actor'->>'platform' = 'slack'
    AND "e"."payload"->'provenance'->'actor'->>'email' IS NOT NULL
),
"proven" AS (
  SELECT "slack"."id", "slack"."user_id", "slack"."provider_tenant_id"
  FROM "junior_identities" AS "slack"
  INNER JOIN "slack_evidence" AS "ev"
    ON "ev"."subject" = "slack"."provider_subject_id"
    AND "ev"."email" = "slack"."email_normalized"
  WHERE "slack"."kind" = 'user'
    AND "slack"."provider" = 'slack'
    AND "slack"."user_id" IS NOT NULL
),
"web_posts" AS (
  SELECT DISTINCT "web"."user_id", "web"."email_normalized",
    coalesce("c"."root_conversation_id", "c"."conversation_id") AS "root_id"
  FROM "junior_identities" AS "web"
  INNER JOIN "junior_conversation_events" AS "posted"
    ON "posted"."actor_identity_id" = "web"."id"
  INNER JOIN "junior_conversations" AS "c"
    ON "c"."conversation_id" = "posted"."conversation_id"
  WHERE "web"."kind" = 'user'
    AND "web"."provider" = 'junior'
    AND "web"."user_id" IS NOT NULL
),
"candidates" AS (
  SELECT DISTINCT "slack"."id" AS "identity_id", "slack"."user_id",
    "slack"."provider_tenant_id"
  FROM "junior_identities" AS "slack"
  INNER JOIN "junior_conversations" AS "root"
    ON "root"."actor_identity_id" = "slack"."id"
    AND "root"."parent_conversation_id" IS NULL
  INNER JOIN "web_posts" AS "w"
    ON "w"."root_id" = "root"."conversation_id"
    AND "w"."user_id" = "slack"."user_id"
    AND "w"."email_normalized" = "slack"."email_normalized"
  WHERE "slack"."kind" = 'user'
    AND "slack"."provider" = 'slack'
    AND "slack"."user_id" IS NOT NULL
    AND "slack"."email_verified"
    AND "slack"."id" NOT IN (SELECT "id" FROM "proven")
),
"damaged" AS (
  SELECT "candidate"."identity_id", "candidate"."user_id"
  FROM "candidates" AS "candidate"
  WHERE (
    SELECT count(*)
    FROM "proven" AS "kept"
    WHERE "kept"."user_id" = "candidate"."user_id"
      AND "kept"."provider_tenant_id" = "candidate"."provider_tenant_id"
  ) = 1
),
-- Roots where the link made the poster a Participant: roots that the damaged
-- Identity started, and roots where it sent a Turn.
"affected_roots" AS (
  SELECT "d"."user_id", "root"."conversation_id" AS "root_id"
  FROM "damaged" AS "d"
  INNER JOIN "junior_conversations" AS "root"
    ON "root"."actor_identity_id" = "d"."identity_id"
    AND "root"."parent_conversation_id" IS NULL
  UNION
  SELECT "d"."user_id",
    coalesce("c"."root_conversation_id", "c"."conversation_id") AS "root_id"
  FROM "damaged" AS "d"
  INNER JOIN "junior_conversation_events" AS "e"
    ON "e"."actor_identity_id" = "d"."identity_id"
  INNER JOIN "junior_conversations" AS "c"
    ON "c"."conversation_id" = "e"."conversation_id"
),
-- Keep a row when the User started the root or wrote in it through an
-- Identity that is not damaged.
"removed_participants" AS (
  DELETE FROM "junior_conversation_participants" AS "p"
  USING "affected_roots" AS "a"
  WHERE "p"."user_id" = "a"."user_id"
    AND "p"."root_conversation_id" = "a"."root_id"
    AND NOT EXISTS (
      SELECT 1
      FROM "junior_conversations" AS "root"
      INNER JOIN "junior_identities" AS "starter"
        ON "starter"."id" = "root"."actor_identity_id"
      WHERE "root"."conversation_id" = "a"."root_id"
        AND "starter"."user_id" = "a"."user_id"
        AND "starter"."id" NOT IN (SELECT "identity_id" FROM "damaged")
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "junior_conversations" AS "c"
      INNER JOIN "junior_conversation_events" AS "e"
        ON "e"."conversation_id" = "c"."conversation_id"
      INNER JOIN "junior_identities" AS "author"
        ON "author"."id" = "e"."actor_identity_id"
      WHERE coalesce("c"."root_conversation_id", "c"."conversation_id") = "a"."root_id"
        AND "author"."user_id" = "a"."user_id"
        AND "author"."id" NOT IN (SELECT "identity_id" FROM "damaged")
    )
),
-- The link gave the poster's User the starter's name when the User had none.
-- A User name comes from one of its Identities, so a name that no kept
-- Identity of the User has came from the damaged one. The next save of a
-- kept Identity gives the User a name again.
"renamed_users" AS (
  UPDATE "junior_users" AS "u"
  SET "display_name" = NULL,
    "updated_at" = now()
  FROM "damaged" AS "d"
  INNER JOIN "junior_identities" AS "slack" ON "slack"."id" = "d"."identity_id"
  WHERE "u"."id" = "d"."user_id"
    AND "u"."display_name" = "slack"."display_name"
    AND NOT EXISTS (
      SELECT 1
      FROM "junior_identities" AS "kept"
      WHERE "kept"."user_id" = "d"."user_id"
        AND "kept"."id" NOT IN (SELECT "identity_id" FROM "damaged")
        AND "kept"."display_name" = "u"."display_name"
    )
),
-- The detail report of these roots shows the root Actor and Participants.
"touched_roots" AS (
  UPDATE "junior_conversations" AS "root"
  SET "detail_version" = "root"."detail_version" + 1
  WHERE "root"."conversation_id" IN (SELECT "root_id" FROM "affected_roots")
)
-- Put the Identity back to its state before the link. Slack gave it no
-- email, so a later Slack Turn cannot link it again. The same write copied
-- the poster's name when Slack gave none. The next Slack Turn of the
-- Identity saves its own name again.
UPDATE "junior_identities" AS "i"
SET "user_id" = NULL,
  "email" = NULL,
  "email_normalized" = NULL,
  "email_verified" = false,
  "display_name" = CASE
    WHEN EXISTS (
      SELECT 1
      FROM "junior_identities" AS "web"
      WHERE "web"."user_id" = "d"."user_id"
        AND "web"."provider" = 'junior'
        AND "web"."display_name" = "i"."display_name"
    ) THEN NULL
    ELSE "i"."display_name"
  END,
  "updated_at" = now()
FROM "damaged" AS "d"
WHERE "i"."id" = "d"."identity_id";
