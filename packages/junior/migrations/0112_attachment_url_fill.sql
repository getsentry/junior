-- Fill `url` Attachments and where messages use them, for Conversations
-- active in the last 30 days, with the rules of `batchMessageLinks` in
-- src/chat/conversations/message-links.ts: the text of the newest save of
-- each message, at the seq of its first save, first match of each link only.
-- Ids are `urlAttachmentId`. It runs apart from 0111, so it holds no lock
-- from that migration's ALTER TABLE. It reads the event tables, and its
-- inserts into `junior_attachments` take only a row-exclusive lock, so app
-- reads and writes keep running. Older Conversations show no links in the
-- feed until they get new messages.
WITH "messages" AS (
  SELECT
    "events"."conversation_id",
    min("events"."seq") FILTER (WHERE "events"."type" = 'message') AS "seq",
    (array_agg("events"."payload" ORDER BY "events"."seq" DESC))[1] AS "payload",
    max("events"."created_at") AS "created_at"
  FROM "junior_conversations" AS "conversations"
  INNER JOIN "junior_conversation_events" AS "events"
    ON "events"."conversation_id" = "conversations"."conversation_id"
    AND "events"."type" IN ('message', 'message_updated')
  WHERE "conversations"."last_activity_at" >= now() - interval '30 days'
  GROUP BY "events"."conversation_id", coalesce("events"."payload"->>'messageId', 'seq:' || "events"."seq")
), "links" AS (
  SELECT
    "messages"."conversation_id",
    "messages"."seq",
    "messages"."created_at",
    min("matches"."position") AS "position",
    regexp_replace("matches"."match"[1], '[.,;:!?)\]}*_~]+$', '') AS "url"
  FROM "messages"
  CROSS JOIN LATERAL regexp_matches("messages"."payload"->>'text', 'https?://[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff<>|"''\u0060]+', 'g') WITH ORDINALITY AS "matches"("match", "position")
  WHERE "messages"."seq" IS NOT NULL
    AND coalesce("messages"."payload"->'meta'->>'explicitMention', 'true') <> 'false'
  GROUP BY 1, 2, 3, 5
), "ids" AS (
  SELECT
    "links".*,
    encode(sha256(convert_to("links"."conversation_id" || ' ' || "links"."url", 'UTF8')), 'hex') AS "attachment_id"
  FROM "links"
), "attachments" AS (
  INSERT INTO "junior_attachments" ("id", "kind", "conversation_id", "url", "created_at")
  SELECT DISTINCT ON ("attachment_id") "attachment_id", 'url', "conversation_id", "url", "created_at"
  FROM "ids"
  ORDER BY "attachment_id", "created_at"
  ON CONFLICT ("id") DO NOTHING
)
INSERT INTO "junior_message_attachments" ("conversation_id", "seq", "attachment_id", "position")
SELECT "conversation_id", "seq", "attachment_id", "position"
FROM "ids"
ON CONFLICT DO NOTHING;
