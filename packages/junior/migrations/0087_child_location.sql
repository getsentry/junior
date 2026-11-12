-- Give each existing child the Destination row and Location of its root, as
-- createChild now does for a new child. A child Run then reads visibility and
-- Location from its own row. A child whose chain is broken or has a cycle
-- never joins a root here, so it keeps no Destination row and its Runs are
-- private with no Location. The Location follows locationFromRow:
-- location_json, else a Slack destination row, with the session Source
-- threadTs when the Location has none.
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
    "root"."destination_id",
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
    "destination_id",
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
SET
  "destination_id" = "root_facts"."destination_id",
  "location_json" = "root_facts"."location"
FROM "tree"
JOIN "root_facts" ON "root_facts"."root_id" = "tree"."root_id"
WHERE "child"."conversation_id" = "tree"."conversation_id"
  AND "tree"."depth" > 0
  AND "child"."destination_id" IS NULL
  AND "child"."location_json" IS NULL;
