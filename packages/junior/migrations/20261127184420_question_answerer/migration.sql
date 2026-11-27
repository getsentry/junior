ALTER TABLE "junior_questions" ADD COLUMN "answered_by_user_id" text;--> statement-breakpoint
ALTER TABLE "junior_questions" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
-- The column is new, so every row is null and passes the constraint. NOT
-- VALID skips the scan under lock and still checks every new write.
ALTER TABLE "junior_questions" ADD CONSTRAINT "junior_questions_answered_by_user_id_junior_users_id_fkey" FOREIGN KEY ("answered_by_user_id") REFERENCES "junior_users"("id") ON DELETE SET NULL NOT VALID;--> statement-breakpoint
-- A question now holds who answered it and when. The release before this
-- one still writes them only on the question's Inbox item while this
-- release rolls out: it closes the item with `closed_by_user_id`,
-- `closed_at`, and a copy of the answer. This trigger copies them to the
-- question when such a close lands. New code writes them on the question
-- and leaves the item's answer null, so the trigger never fires for it. A
-- later release drops it.
CREATE OR REPLACE FUNCTION "junior_inbox_items_legacy_question_answerer"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "junior_questions"
  SET "answer" = coalesce("answer", NEW."answer"),
    "answered_by_user_id" = coalesce("answered_by_user_id", NEW."closed_by_user_id"),
    "answered_at" = coalesce("answered_at", NEW."closed_at")
  WHERE "id" = NEW."subject_id";
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "junior_inbox_items_legacy_question_answerer" AFTER UPDATE ON "junior_inbox_items" FOR EACH ROW WHEN (NEW."subject_kind" = 'question' AND NEW."status" = 'done' AND NEW."answer" IS NOT NULL AND OLD."answer" IS NULL) EXECUTE FUNCTION "junior_inbox_items_legacy_question_answerer"();--> statement-breakpoint
-- junior:bounded-backfill: it writes each answered question once, from its one Inbox item. People answer these by hand, so there are few of them.
UPDATE "junior_questions"
SET "answer" = coalesce("junior_questions"."answer", "junior_inbox_items"."answer"),
  "answered_by_user_id" = "junior_inbox_items"."closed_by_user_id",
  "answered_at" = "junior_inbox_items"."closed_at"
FROM "junior_inbox_items"
WHERE "junior_inbox_items"."subject_kind" = 'question'
  AND "junior_inbox_items"."subject_id" = "junior_questions"."id"
  AND "junior_inbox_items"."status" = 'done'
  AND coalesce("junior_questions"."answer", "junior_inbox_items"."answer") IS NOT NULL;
