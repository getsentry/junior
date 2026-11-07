ALTER TABLE "junior_conversations" ADD COLUMN "spawn_json" jsonb;--> statement-breakpoint
-- Give each existing child the root Location, visibility, and depth that its
-- Runs read from the root before, so children in flight keep working.
-- Missing or unknown visibility is private. A child whose chain is broken or
-- has a cycle never joins a root here, so it gets no copy. Its Runs are then
-- private, with no Location, and cannot spawn. The Location follows
-- locationFromRow: location_json, else a Slack destination row, with the
-- session Source threadTs when the Location has none.
WITH RECURSIVE "tree" ("conversation_id", "root_id", "depth", "path") AS (
  SELECT "conversation_id", "conversation_id", 0, ARRAY["conversation_id"]
  FROM "junior_conversations"
  WHERE "parent_conversation_id" IS NULL
  UNION ALL
  SELECT "child"."conversation_id", "tree"."root_id", "tree"."depth" + 1, "tree"."path" || "child"."conversation_id"
  FROM "junior_conversations" "child"
  JOIN "tree" ON "child"."parent_conversation_id" = "tree"."conversation_id"
  WHERE "child"."conversation_id" <> ALL ("tree"."path")
),
"root_place" AS (
  SELECT
    "root"."conversation_id" AS "root_id",
    CASE WHEN "destination"."visibility" = 'public' THEN 'public' ELSE 'private' END AS "visibility",
    CASE
      WHEN "root"."location_json" IS NOT NULL THEN "root"."location_json"
      WHEN "destination"."provider" = 'slack' THEN jsonb_build_object(
        'id', "destination"."id",
        'provider', 'slack',
        'teamId', "destination"."provider_tenant_id",
        'channelId', "destination"."provider_destination_id"
      )
    END AS "location",
    nullif(btrim("root"."source_json"->>'threadTs'), '') AS "source_thread_ts",
    "root"."source_json"->>'kind' AS "source_kind",
    "root"."source_json"->>'teamId' AS "source_team_id",
    "root"."source_json"->>'channelId' AS "source_channel_id"
  FROM "junior_conversations" "root"
  LEFT JOIN "junior_destinations" "destination" ON "destination"."id" = "root"."destination_id"
  WHERE "root"."parent_conversation_id" IS NULL
),
"root_facts" AS (
  SELECT
    "root_id",
    "visibility",
    CASE
      WHEN "location" IS NOT NULL
        AND "location"->>'threadTs' IS NULL
        AND "source_kind" = 'slack'
        AND "source_team_id" = "location"->>'teamId'
        AND "source_channel_id" = "location"->>'channelId'
        AND "source_thread_ts" IS NOT NULL
      THEN "location" || jsonb_build_object('threadTs', "source_thread_ts")
      ELSE "location"
    END AS "location"
  FROM "root_place"
)
UPDATE "junior_conversations" "child"
SET "spawn_json" = jsonb_strip_nulls(jsonb_build_object(
  'depth', "tree"."depth",
  'location', "root_facts"."location",
  'visibility', "root_facts"."visibility"
))
FROM "tree"
JOIN "root_facts" ON "root_facts"."root_id" = "tree"."root_id"
WHERE "child"."conversation_id" = "tree"."conversation_id"
  AND "tree"."depth" > 0
  AND "child"."spawn_json" IS NULL;
