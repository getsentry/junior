CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "junior_artifacts_public_sha_uidx" ON "junior_artifacts" USING btree ("conversation_id","sha256") WHERE "junior_artifacts"."visibility" = 'public';
