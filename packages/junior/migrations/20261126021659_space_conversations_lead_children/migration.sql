-- A Space's Conversations are now children of its Lead, and only the Lead
-- stores `space_id`. The Lead is the root of every Conversation in its
-- Space, so `root_conversation_id` of each moved Conversation's work becomes
-- the Lead.

-- A Space that has Conversations but no Lead yet gets one, as the first
-- open of the Space would make it. Its first Actor is the Space's creator.
WITH "needs_lead" AS (
  SELECT
    "space"."id" AS "space_id",
    "space"."name",
    "space"."visibility",
    'local:web:' || gen_random_uuid()::text AS "conversation_id",
    gen_random_uuid()::text AS "destination_id",
    (
      SELECT "identity"."id"
      FROM "junior_identities" "identity"
      WHERE "identity"."user_id" = "space"."created_by_user_id"
      ORDER BY ("identity"."provider" = 'web') DESC, "identity"."created_at"
      LIMIT 1
    ) AS "actor_identity_id"
  FROM "junior_spaces" "space"
  WHERE EXISTS (
    SELECT 1
    FROM "junior_conversations" "member"
    WHERE "member"."space_id" = "space"."id"
      AND "member"."kind" IS DISTINCT FROM 'lead'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "junior_conversations" "lead"
    WHERE "lead"."space_id" = "space"."id" AND "lead"."kind" = 'lead'
  )
),
"lead_destination" AS (
  INSERT INTO "junior_destinations" (
    "id",
    "provider",
    "provider_tenant_id",
    "provider_destination_id",
    "kind",
    "visibility",
    "metadata_json",
    "created_at",
    "updated_at"
  )
  SELECT
    "destination_id",
    'local',
    'web',
    "conversation_id",
    'local_conversation',
    "visibility",
    '{"platform":"local"}'::jsonb,
    now(),
    now()
  FROM "needs_lead"
)
INSERT INTO "junior_conversations" (
  "conversation_id",
  "source",
  "source_json",
  "destination_id",
  "actor_identity_id",
  "title",
  "created_at",
  "last_activity_at",
  "updated_at",
  "execution_updated_at",
  "execution_status",
  "root_conversation_id",
  "kind",
  "space_id",
  "visibility"
)
SELECT
  "conversation_id",
  'web',
  jsonb_build_object(
    'kind', 'web',
    'visibility', "visibility",
    'conversationId', "conversation_id"
  ),
  "destination_id",
  "actor_identity_id",
  "name",
  now(),
  now(),
  now(),
  now(),
  'idle',
  "conversation_id",
  'lead',
  "space_id",
  "visibility"
FROM "needs_lead";
--> statement-breakpoint

-- A move never makes private work public, so a private Conversation in a
-- public Space leaves the Space and stays a private one-off. An Automation
-- run never has a parent, so it leaves its Space too.
-- junior:bounded-backfill: runs once, on the few roots in a Space. Spaces are new and small.
UPDATE "junior_conversations"
SET "space_id" = NULL, "detail_version" = "detail_version" + 1
WHERE "space_id" IS NOT NULL
  AND "kind" IS DISTINCT FROM 'lead'
  AND (
    "kind" = 'automation'
    OR (
      "visibility" IS DISTINCT FROM 'public'
      AND "space_id" IN (
        SELECT "id" FROM "junior_spaces" WHERE "visibility" = 'public'
      )
    )
  );
--> statement-breakpoint

-- The work of every other root in a Space joins the Lead's tree.
-- junior:bounded-backfill: runs once, on the work of the few roots in a Space. Spaces are new and small.
UPDATE "junior_conversations" "work"
SET
  "root_conversation_id" = "lead"."conversation_id",
  "detail_version" = "work"."detail_version" + 1
FROM "junior_conversations" "member", "junior_conversations" "lead"
WHERE "lead"."kind" = 'lead'
  AND "lead"."space_id" = "member"."space_id"
  AND "member"."kind" IS DISTINCT FROM 'lead'
  AND "member"."parent_conversation_id" IS NULL
  AND coalesce("work"."root_conversation_id", "work"."conversation_id") = "member"."conversation_id";
--> statement-breakpoint

-- Each such root becomes a child of the Space's Lead. A Lead's children are
-- its child agents, so each stores an agent config.
-- junior:bounded-backfill: runs once, on the few roots in a Space. Spaces are new and small.
UPDATE "junior_conversations" "member"
SET
  "parent_conversation_id" = "lead"."conversation_id",
  "agent_config_json" = coalesce("member"."agent_config_json", '{}'::jsonb),
  "space_id" = NULL,
  "detail_version" = "member"."detail_version" + 1
FROM "junior_conversations" "lead"
WHERE "lead"."kind" = 'lead'
  AND "lead"."space_id" = "member"."space_id"
  AND "member"."kind" IS DISTINCT FROM 'lead'
  AND "member"."parent_conversation_id" IS NULL;
