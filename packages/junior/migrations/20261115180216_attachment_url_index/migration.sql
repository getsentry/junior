CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "junior_attachments_conversation_url_idx" ON "junior_attachments" USING btree ("conversation_id","url") WHERE "junior_attachments"."url" IS NOT NULL;
