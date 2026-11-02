-- Store one vector per memory per model, with vectors of more than one size.
-- This lets a new embedding model be backfilled while reads use the old one.
-- These statements lock junior_memory_embeddings until the migration ends, and
-- the 1536 HNSW index is rebuilt over existing rows. Check the row count first.
ALTER TABLE "junior_memory_embeddings" DROP CONSTRAINT "junior_memory_embeddings_dimensions_check";--> statement-breakpoint
DROP INDEX "junior_memory_embeddings_embedding_hnsw_idx";--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" DROP CONSTRAINT "junior_memory_embeddings_pkey";--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector;--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" ADD CONSTRAINT "junior_memory_embeddings_memory_id_provider_model_pk" PRIMARY KEY("memory_id","provider","model");--> statement-breakpoint
CREATE INDEX "junior_memory_embeddings_embedding_1024_hnsw_idx" ON "junior_memory_embeddings" USING hnsw (("embedding"::vector(1024)) vector_cosine_ops) WITH (m=16,ef_construction=64) WHERE "junior_memory_embeddings"."dimensions" = 1024;--> statement-breakpoint
CREATE INDEX "junior_memory_embeddings_embedding_1536_hnsw_idx" ON "junior_memory_embeddings" USING hnsw (("embedding"::vector(1536)) vector_cosine_ops) WITH (m=16,ef_construction=64) WHERE "junior_memory_embeddings"."dimensions" = 1536;--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" ADD CONSTRAINT "junior_memory_embeddings_dimensions_check" CHECK ("junior_memory_embeddings"."dimensions" IN (1024, 1536) AND vector_dims("junior_memory_embeddings"."embedding") = "junior_memory_embeddings"."dimensions");
