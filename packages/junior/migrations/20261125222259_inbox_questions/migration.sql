-- A question now holds its own content, and its Inbox item points at it
-- with the subject `{ kind: "question", id }`. Each existing question item
-- gets a question with the item's id, and its content moves there. The
-- request's `evidence` links are now its `related` links.
CREATE TABLE "junior_questions" (
	"id" text PRIMARY KEY,
	"conversation_id" text NOT NULL,
	"turn_id" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"request" jsonb,
	"answer" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "junior_questions" ADD CONSTRAINT "junior_questions_HSrO9i8pUj0G_fkey" FOREIGN KEY ("conversation_id") REFERENCES "junior_conversations"("conversation_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "junior_questions_conversation_idx" ON "junior_questions" ("conversation_id");--> statement-breakpoint
CREATE INDEX "junior_questions_search_idx" ON "junior_questions" USING gin ((setweight(to_tsvector('simple', "title"), 'A') || setweight(to_tsvector('simple', "body"), 'B')));--> statement-breakpoint
CREATE INDEX "junior_questions_title_trgm_idx" ON "junior_questions" USING gin (lower("title") gin_trgm_ops);--> statement-breakpoint
-- Old workers still write a question item's content on the item while this
-- release rolls out: its title, body, and request when they add or change
-- it, and its answer when they close it. This trigger copies that content
-- to the item's question, so new code reads it there. A new item's question
-- takes the item's id, and the request's `evidence` key becomes `related`.
-- A notice keeps its link in `subject_url`, which becomes its one related
-- link. The item keeps its own copy, because the old columns and checks
-- stay for the release before this one. The trigger copies only content
-- that changed, so a write of new code, which leaves the item's copy as it
-- is, never copies an old copy over the question. The backfill below fires
-- the same trigger. Its name sorts after `junior_inbox_items_legacy_subject`,
-- which gives an old worker's new item its subject kind first.
CREATE OR REPLACE FUNCTION "junior_inbox_items_legacy_question"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  question_request jsonb := NEW."request";
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW."subject_id" IS NOT DISTINCT FROM OLD."subject_id"
    AND NEW."title" IS NOT DISTINCT FROM OLD."title"
    AND NEW."body" IS NOT DISTINCT FROM OLD."body"
    AND NEW."request" IS NOT DISTINCT FROM OLD."request"
    AND NEW."answer" IS NOT DISTINCT FROM OLD."answer"
  THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."subject_id" := NEW."id";
  END IF;
  IF question_request ? 'evidence' THEN
    question_request := (question_request - 'evidence') || jsonb_build_object('related', question_request -> 'evidence');
  END IF;
  IF question_request IS NULL AND NEW."kind" = 'notice' AND NEW."subject_url" ~* '^https?://' THEN
    question_request := jsonb_build_object('related', jsonb_build_array(jsonb_build_object('label', left(coalesce(nullif(NEW."subject_title", ''), NEW."subject_url"), 120), 'url', "junior_inbox_items_web_link"(NEW."subject_url"))));
  END IF;
  INSERT INTO "junior_questions" ("id", "conversation_id", "turn_id", "title", "body", "request", "answer", "created_at", "updated_at")
  VALUES (NEW."subject_id", NEW."owner_id", NEW."added_by_turn_id", coalesce(NEW."title", ''), coalesce(NEW."body", ''), question_request, NEW."answer", NEW."created_at", NEW."updated_at")
  ON CONFLICT ("id") DO UPDATE SET
    "title" = coalesce(NEW."title", "junior_questions"."title"),
    "body" = coalesce(NEW."body", "junior_questions"."body"),
    "request" = coalesce(question_request, "junior_questions"."request"),
    "answer" = coalesce(NEW."answer", "junior_questions"."answer"),
    "updated_at" = NEW."updated_at";
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "junior_inbox_items_legacy_subject_question" BEFORE INSERT OR UPDATE ON "junior_inbox_items" FOR EACH ROW WHEN (NEW."subject_kind" = 'question' AND (NEW."title" IS NOT NULL OR NEW."body" IS NOT NULL OR NEW."request" IS NOT NULL OR NEW."answer" IS NOT NULL)) EXECUTE FUNCTION "junior_inbox_items_legacy_question"();--> statement-breakpoint
-- A question belongs to its Conversation. A question item whose owner
-- Conversation is gone has no place for its question, and nobody can see
-- it, so the migration deletes it. Its snoozes and other rows go with it.
-- junior:bounded-backfill: it deletes only the question items whose owner Conversation row is gone, which Junior does not expect to find, once.
DELETE FROM "junior_inbox_items" WHERE "subject_kind" = 'question' AND NOT EXISTS (SELECT 1 FROM "junior_conversations" WHERE "junior_conversations"."conversation_id" = "junior_inbox_items"."owner_id");--> statement-breakpoint
-- junior:bounded-backfill: each question item moves its content to a new question once, through the trigger above, and the question takes the item's id. It reads only the question items, which are asks and notices for people, and writes each row once.
UPDATE "junior_inbox_items" SET "subject_id" = "id" WHERE "subject_kind" = 'question';
