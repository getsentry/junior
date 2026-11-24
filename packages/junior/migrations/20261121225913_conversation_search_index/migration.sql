CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_conversations_search_idx" ON "junior_conversations" USING gin (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("summary", '')));
