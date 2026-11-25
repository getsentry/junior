CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_code_changes_repository_state_idx" ON "junior_code_changes" USING btree ("repository_id","state","updated_at" DESC NULLS LAST);
