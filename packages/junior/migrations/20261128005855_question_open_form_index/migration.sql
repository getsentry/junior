-- A question that `askUserQuestion` asks stores its form as `fields` with no
-- top-level `question`, so the waiting predicate now matches `fields`. A
-- notice has no form either way.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_questions_open_form_idx" ON "junior_questions" USING btree ("conversation_id") WHERE ("closed_at" is null and "request" ? 'fields');
