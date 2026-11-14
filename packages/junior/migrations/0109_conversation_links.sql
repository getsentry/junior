CREATE TABLE "junior_conversation_links" (
	"conversation_id" text NOT NULL,
	"seq" integer NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "junior_conversation_links_pk" PRIMARY KEY("conversation_id","seq","position")
);--> statement-breakpoint
-- Fill links for Conversations active in the last 30 days, with the rules of
-- `messageLinkRows` in src/chat/conversations/message-links.ts. It only reads
-- the existing tables and inserts into the new one, so it blocks no app
-- writes. Older Conversations show no links in the feed until they get new
-- messages.
INSERT INTO "junior_conversation_links" ("conversation_id", "seq", "position", "url")
SELECT "events"."conversation_id", "events"."seq", "matches"."position", "matches"."match"[1]
FROM "junior_conversations" AS "conversations"
INNER JOIN "junior_conversation_events" AS "events"
  ON "events"."conversation_id" = "conversations"."conversation_id"
  AND "events"."type" = 'message'
CROSS JOIN LATERAL regexp_matches("events"."payload"->>'text', 'https?://[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff<>|"''\u0060]+', 'g') WITH ORDINALITY AS "matches"("match", "position")
WHERE "conversations"."last_activity_at" >= now() - interval '30 days'
  AND coalesce("events"."payload"->'meta'->>'explicitMention', 'true') <> 'false'
ON CONFLICT DO NOTHING;
