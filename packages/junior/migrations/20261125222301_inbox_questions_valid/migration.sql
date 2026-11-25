-- VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE, so reads and writes
-- keep going during the scan.
ALTER TABLE "junior_inbox_items" VALIDATE CONSTRAINT "junior_inbox_items_kind_check";
