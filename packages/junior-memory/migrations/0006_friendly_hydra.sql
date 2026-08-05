CREATE EXTENSION IF NOT EXISTS btree_gin;--> statement-breakpoint
DROP INDEX "junior_memory_memories_search_idx";--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;--> statement-breakpoint
CREATE INDEX "junior_memory_memories_search_idx" ON "junior_memory_memories" USING gin ("scope","scope_key","search_vector") WHERE "junior_memory_memories"."archived_at_ms" IS NULL AND "junior_memory_memories"."superseded_at_ms" IS NULL AND "junior_memory_memories"."superseded_by_id" IS NULL;
