CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_inbox_items_subject_kind_idx" ON "junior_inbox_items" USING btree ("subject_kind","status");
