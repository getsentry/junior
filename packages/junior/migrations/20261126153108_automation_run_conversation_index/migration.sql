CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_automation_runs_conversation_idx" ON "junior_automation_runs" USING btree ("conversation_id");
