CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_questions_waiting_idx" ON "junior_questions" USING btree ("conversation_id") WHERE ("closed_at" is null and "request" ? 'question');
