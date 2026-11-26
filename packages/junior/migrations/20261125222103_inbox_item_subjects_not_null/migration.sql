-- VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE, so reads and writes
-- keep going during the scan. SET NOT NULL then reads the valid checks and
-- skips its own scan. The previous migration added the two checks, so no
-- release uses them.
ALTER TABLE "junior_inbox_items" VALIDATE CONSTRAINT "junior_inbox_items_subject_kind_not_null";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" VALIDATE CONSTRAINT "junior_inbox_items_subject_id_not_null";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" ALTER COLUMN "subject_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_inbox_items" ALTER COLUMN "subject_id" SET NOT NULL;--> statement-breakpoint
-- squawk-ignore ban-drop-constraint -- unused since 0.315.0
ALTER TABLE "junior_inbox_items" DROP CONSTRAINT "junior_inbox_items_subject_kind_not_null";--> statement-breakpoint
-- squawk-ignore ban-drop-constraint -- unused since 0.315.0
ALTER TABLE "junior_inbox_items" DROP CONSTRAINT "junior_inbox_items_subject_id_not_null";
