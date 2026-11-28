ALTER TABLE "junior_questions" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
-- A question now holds when its Inbox item closed. The release before this
-- one still closes and dismisses only the item while this release rolls
-- out. This trigger copies the item's `closed_at` to its question when
-- such a close lands. New code sets the question's `closed_at` in the same
-- transaction, so the trigger then changes nothing. A later release drops
-- it.
CREATE OR REPLACE FUNCTION "junior_inbox_items_legacy_question_closed_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "junior_questions"
  SET "closed_at" = NEW."closed_at"
  WHERE "id" = NEW."subject_id"
    AND "closed_at" IS NULL;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "junior_inbox_items_legacy_question_closed_at" AFTER UPDATE ON "junior_inbox_items" FOR EACH ROW WHEN (NEW."subject_kind" = 'question' AND OLD."status" = 'open' AND NEW."status" <> 'open') EXECUTE FUNCTION "junior_inbox_items_legacy_question_closed_at"();--> statement-breakpoint
-- junior:bounded-backfill: it writes each closed question once, from its one Inbox item. Questions are a small table: one row for each question an agent asked.
UPDATE "junior_questions"
SET "closed_at" = coalesce("junior_inbox_items"."closed_at", "junior_inbox_items"."updated_at")
FROM "junior_inbox_items"
WHERE "junior_inbox_items"."subject_kind" = 'question'
  AND "junior_inbox_items"."subject_id" = "junior_questions"."id"
  AND "junior_inbox_items"."status" <> 'open'
  AND "junior_questions"."closed_at" IS NULL;
