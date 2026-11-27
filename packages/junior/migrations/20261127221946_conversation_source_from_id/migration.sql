-- Junior no longer reads meaning from a Conversation id. Readers take the
-- surface from the stored Source, so this writes it once for rows that only
-- their id described.
-- junior:bounded-backfill: runs once, on old rows written before every root stored its Source. No writer changes them.
UPDATE "junior_conversations"
SET "source" = CASE
    WHEN "conversation_id" LIKE 'slack:%' THEN 'slack'
    WHEN "conversation_id" LIKE 'scheduler:%' THEN 'scheduler'
    WHEN "conversation_id" LIKE 'api:%' THEN 'api'
    ELSE 'web'
  END,
  "detail_version" = "detail_version" + 1
WHERE "source" IS NULL
  AND (
    "conversation_id" LIKE 'slack:%'
    OR "conversation_id" LIKE 'scheduler:%'
    OR "conversation_id" LIKE 'api:%'
    OR "conversation_id" LIKE 'local:web:%'
  );--> statement-breakpoint

-- An ACP session is an API Conversation, not a dashboard one. It takes no
-- dashboard Message and cannot move to Slack.
-- junior:bounded-backfill: runs once, on the few ACP sessions. Writers keep a stored Source.
UPDATE "junior_conversations"
SET "source" = 'api', "detail_version" = "detail_version" + 1
WHERE "source" = 'web' AND "conversation_id" LIKE 'local:acp:%';--> statement-breakpoint

-- An event automation run's id is its dispatch id. Readers take the dispatch
-- from dispatch_id, as they do for a Scheduled automation run.
-- junior:bounded-backfill: runs once. Settled runs have no writer, and few runs are running.
UPDATE "junior_automation_runs" AS "run"
SET "dispatch_id" = "run"."id"
FROM "junior_automations" AS "automation"
WHERE "automation"."id" = "run"."automation_id"
  AND "automation"."kind" = 'event'
  AND "run"."dispatch_id" IS NULL;
