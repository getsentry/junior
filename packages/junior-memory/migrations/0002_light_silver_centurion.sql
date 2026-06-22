CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "junior_memory_embeddings" (
	"memory_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"metric" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at_ms" bigint NOT NULL,
	CONSTRAINT "junior_memory_embeddings_metric_check" CHECK ("junior_memory_embeddings"."metric" IN ('cosine')),
	CONSTRAINT "junior_memory_embeddings_dimensions_check" CHECK ("junior_memory_embeddings"."dimensions" = 1536)
);
--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" ADD CONSTRAINT "junior_memory_embeddings_memory_id_junior_memory_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."junior_memory_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_memory_embeddings_model_idx" ON "junior_memory_embeddings" USING btree ("provider","model","dimensions","metric");
