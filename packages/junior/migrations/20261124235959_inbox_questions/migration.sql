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
ALTER TABLE "junior_inbox_items" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_inbox_items" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_inbox_items" DROP CONSTRAINT "junior_inbox_items_kind_check";--> statement-breakpoint
-- Old workers still write a question item's content on the item while this
-- release rolls out: its title, body, and request when they add or change
-- it, and its answer when they close it. This trigger moves that content to
-- the item's question, so new code reads it there. A new item's question
-- takes the item's id, and the request's `evidence` key becomes `related`.
-- The backfill below fires the same trigger. Its name
-- sorts after `junior_inbox_items_legacy_subject`, which gives an old
-- worker's new item its subject kind first.
CREATE OR REPLACE FUNCTION "junior_inbox_items_legacy_question"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."subject_id" := NEW."id";
  END IF;
  IF NEW."request" ? 'evidence' THEN
    NEW."request" := (NEW."request" - 'evidence') || jsonb_build_object('related', NEW."request" -> 'evidence');
  END IF;
  INSERT INTO "junior_questions" ("id", "conversation_id", "turn_id", "title", "body", "request", "answer", "created_at", "updated_at")
  VALUES (NEW."subject_id", NEW."owner_id", NEW."added_by_turn_id", coalesce(NEW."title", ''), coalesce(NEW."body", ''), NEW."request", NEW."answer", NEW."created_at", NEW."updated_at")
  ON CONFLICT ("id") DO UPDATE SET
    "title" = coalesce(NEW."title", "junior_questions"."title"),
    "body" = coalesce(NEW."body", "junior_questions"."body"),
    "request" = coalesce(NEW."request", "junior_questions"."request"),
    "answer" = coalesce(NEW."answer", "junior_questions"."answer"),
    "updated_at" = NEW."updated_at";
  NEW."title" := NULL;
  NEW."body" := NULL;
  NEW."request" := NULL;
  NEW."answer" := NULL;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "junior_inbox_items_legacy_subject_question" BEFORE INSERT OR UPDATE ON "junior_inbox_items" FOR EACH ROW WHEN (NEW."subject_kind" = 'question' AND (NEW."title" IS NOT NULL OR NEW."body" IS NOT NULL OR NEW."request" IS NOT NULL OR NEW."answer" IS NOT NULL)) EXECUTE FUNCTION "junior_inbox_items_legacy_question"();--> statement-breakpoint
-- A question belongs to its Conversation. A question item whose owner
-- Conversation is gone has no place for its question, so the migration
-- stops and changes nothing. Junior keeps every Conversation row, so no
-- such item is expected.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "junior_inbox_items" WHERE "subject_kind" = 'question' AND NOT EXISTS (SELECT 1 FROM "junior_conversations" WHERE "junior_conversations"."conversation_id" = "junior_inbox_items"."owner_id")) THEN
    RAISE EXCEPTION 'A question item in junior_inbox_items has no owner Conversation in junior_conversations, so it cannot get its question. Find these items with: SELECT id FROM junior_inbox_items WHERE subject_kind = ''question'' AND owner_id NOT IN (SELECT conversation_id FROM junior_conversations)';
  END IF;
END
$$;--> statement-breakpoint
-- junior:bounded-backfill: each question item moves its content to a new question once, through the trigger above, and the question takes the item's id. It reads only the question items, which are asks and notices for people, and writes each row once.
UPDATE "junior_inbox_items" SET "subject_id" = "id" WHERE "subject_kind" = 'question';--> statement-breakpoint
-- NOT VALID: the backfill left no question item with an answer of its
-- own, and the check holds for every new write. The next migration
-- validates it without a lock that blocks reads.
ALTER TABLE "junior_inbox_items" ADD CONSTRAINT "junior_inbox_items_kind_check" CHECK (("kind" = 'notice' and "request" -> 'question' is null and "answer" is null) or ("kind" = 'action' and ("request" -> 'question' is not null or ("subject_kind" <> 'reply' and "answer" is null)))) NOT VALID;
