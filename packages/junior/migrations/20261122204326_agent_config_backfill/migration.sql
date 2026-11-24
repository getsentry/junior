-- Child agents now run only from parent messages, and every reader finds a
-- child agent by its stored agent config. A child that an Agent invocation
-- started before #3435 has no agent config, so copy it from the first
-- invocation of that child, the one that its spawn wrote. A legacy child from
-- before the kind column reads as a Task.
--
-- The snapshot no longer has junior_agent_invocations, and runtime code no
-- longer reads or writes it. The table stays in the database until a check
-- shows that no invocation in it still waits to run or to report. A later
-- migration drops it with DROP TABLE IF EXISTS.
-- junior:bounded-backfill: runs once and changes only child Conversations that an Agent invocation names, which no release writes since #3435. The update sets only columns that are null.
WITH "spawn" AS (
  SELECT DISTINCT ON ("child_conversation_id")
    "child_conversation_id",
    "agent_type",
    "fork",
    "reasoning_level",
    "title"
  FROM "junior_agent_invocations"
  ORDER BY "child_conversation_id", "created_at"
)
UPDATE "junior_conversations" AS "conversations"
SET
  "agent_config_json" = jsonb_strip_nulls(jsonb_build_object(
    'agentType', "spawn"."agent_type",
    'fork', CASE WHEN "spawn"."fork" THEN true END,
    'reasoningLevel', "spawn"."reasoning_level"
  )),
  "kind" = COALESCE("conversations"."kind", 'task'),
  "title" = COALESCE("conversations"."title", "spawn"."title"),
  "detail_version" = "conversations"."detail_version" + 1
FROM "spawn"
WHERE "spawn"."child_conversation_id" = "conversations"."conversation_id"
  AND "conversations"."agent_config_json" IS NULL;
