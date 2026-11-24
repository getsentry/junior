CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "junior_artifacts_conversation_path_uidx" ON "junior_artifacts" USING btree ("conversation_id","path");
