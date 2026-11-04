-- Store one vector per memory per model, with vectors of more than one size.
-- This lets a new embedding model be backfilled while reads use the old one.
-- No statement here builds an HNSW graph over existing rows, so the table lock
-- is short. Changing the column to an untyped vector changes only the catalog.
-- The 1024 index is empty, because no 1024 vectors exist yet. A 1536 index
-- cannot be prebuilt with CONCURRENTLY, because this type change rebuilds every
-- partial or expression index on the column. Building it here would block
-- reads and writes for the whole build. So 1536 vectors have no ANN index.
ALTER TABLE "junior_memory_embeddings" DROP CONSTRAINT "junior_memory_embeddings_dimensions_check";--> statement-breakpoint
DROP INDEX "junior_memory_embeddings_embedding_hnsw_idx";--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" DROP CONSTRAINT "junior_memory_embeddings_pkey";--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector;--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" ADD CONSTRAINT "junior_memory_embeddings_memory_id_provider_model_pk" PRIMARY KEY("memory_id","provider","model");--> statement-breakpoint
CREATE INDEX "junior_memory_embeddings_embedding_1024_hnsw_idx" ON "junior_memory_embeddings" USING hnsw (("embedding"::vector(1024)) vector_cosine_ops) WITH (m=16,ef_construction=64) WHERE "junior_memory_embeddings"."dimensions" = 1024;--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" ADD CONSTRAINT "junior_memory_embeddings_dimensions_check" CHECK ("junior_memory_embeddings"."dimensions" IN (1024, 1536) AND vector_dims("junior_memory_embeddings"."embedding") = "junior_memory_embeddings"."dimensions");
