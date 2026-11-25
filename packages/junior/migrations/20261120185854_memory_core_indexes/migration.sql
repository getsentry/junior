-- The Memory indexes. A database that ran the Memory plugin has them already,
-- and IF NOT EXISTS skips them without a lock that blocks app writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_memory_embeddings_model_idx" ON "junior_memory_embeddings" USING btree ("provider","model","dimensions","metric");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_memory_embeddings_embedding_1024_hnsw_idx" ON "junior_memory_embeddings" USING hnsw (("embedding"::vector(1024)) vector_cosine_ops) WITH (m=16,ef_construction=64) WHERE "junior_memory_embeddings"."dimensions" = 1024;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_memory_memories_visible_idx" ON "junior_memory_memories" USING btree ("scope","scope_key","created_at_ms" DESC NULLS LAST,"id") WHERE "junior_memory_memories"."archived_at_ms" IS NULL AND "junior_memory_memories"."superseded_at_ms" IS NULL AND "junior_memory_memories"."superseded_by_id" IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_memory_memories_expiration_idx" ON "junior_memory_memories" USING btree ("expires_at_ms") WHERE "junior_memory_memories"."archived_at_ms" IS NULL AND "junior_memory_memories"."expires_at_ms" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_memory_memories_search_idx" ON "junior_memory_memories" USING gin ("scope","scope_key","search_vector") WHERE "junior_memory_memories"."archived_at_ms" IS NULL AND "junior_memory_memories"."superseded_at_ms" IS NULL AND "junior_memory_memories"."superseded_by_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "junior_memory_memories_idempotency_idx" ON "junior_memory_memories" USING btree ("scope","scope_key","idempotency_key") WHERE "junior_memory_memories"."idempotency_key" IS NOT NULL AND "junior_memory_memories"."archived_at_ms" IS NULL AND "junior_memory_memories"."superseded_at_ms" IS NULL AND "junior_memory_memories"."superseded_by_id" IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_memory_memories_archived_idempotency_idx" ON "junior_memory_memories" USING btree ("scope","scope_key","idempotency_key") WHERE "junior_memory_memories"."idempotency_key" IS NOT NULL AND "junior_memory_memories"."archived_at_ms" IS NOT NULL AND "junior_memory_memories"."archive_reason" <> 'expired';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_memory_signals_observed_idx" ON "junior_memory_signals" USING btree ("memory_id","signal","observed_at_ms");
