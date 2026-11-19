-- Memory moved from the @sentry/junior-memory plugin into core. A database
-- that ran the plugin already has these tables, and this migration leaves
-- them and the plugin journal unchanged. A fresh database gets the final
-- Memory schema. Columns keep the order that the plugin migrations made.
-- Stop on a database that has only part of the plugin migrations, so that the
-- plugin data changes never run out of order.
-- The journal query is dynamic because PL/pgSQL plans a static query before
-- the to_regclass check runs.
DO $$
DECLARE
  plugin_complete boolean;
BEGIN
  IF to_regclass('drizzle.__drizzle_memory_c064fbca') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT EXISTS (
    SELECT 1
    FROM drizzle.__drizzle_memory_c064fbca
    WHERE created_at >= 1793829580242
  )' INTO plugin_complete;
  IF NOT plugin_complete THEN
    RAISE EXCEPTION 'The Memory plugin migrations are not complete. Run junior upgrade with @sentry/junior 0.310.0 and @sentry/junior-memory 0.310.0 first.';
  END IF;
END $$;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "junior_memory_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_key" text,
	"content" text NOT NULL,
	"source_platform" text NOT NULL,
	"source_key" text NOT NULL,
	"idempotency_key" text,
	"observed_at_ms" bigint NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"expires_at_ms" bigint,
	"superseded_at_ms" bigint,
	"superseded_by_id" text,
	"archived_at_ms" bigint,
	"archive_reason" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED,
	"location_id" text,
	"conversation_id" text,
	CONSTRAINT "junior_memory_memories_scope_check" CHECK ("junior_memory_memories"."scope" IN ('private', 'public')),
	CONSTRAINT "junior_memory_memories_kind_check" CHECK ("junior_memory_memories"."type" IN ('preference', 'procedure', 'knowledge')),
	CONSTRAINT "junior_memory_memories_subject_type_check" CHECK ("junior_memory_memories"."subject_type" IN ('user', 'conversation', 'general')),
	CONSTRAINT "junior_memory_memories_subject_key_check" CHECK (("junior_memory_memories"."subject_type" = 'general' AND "junior_memory_memories"."subject_key" IS NULL) OR ("junior_memory_memories"."subject_type" IN ('user', 'conversation') AND "junior_memory_memories"."subject_key" IS NOT NULL AND length("junior_memory_memories"."subject_key") > 0)),
	CONSTRAINT "junior_memory_memories_source_platform_check" CHECK ("junior_memory_memories"."source_platform" IN ('slack', 'local', 'web'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "junior_memory_embeddings" (
	"memory_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"metric" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector NOT NULL,
	"created_at_ms" bigint NOT NULL,
	CONSTRAINT "junior_memory_embeddings_memory_id_provider_model_pk" PRIMARY KEY("memory_id","provider","model"),
	CONSTRAINT "junior_memory_embeddings_memory_id_junior_memory_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."junior_memory_memories"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "junior_memory_embeddings_metric_check" CHECK ("junior_memory_embeddings"."metric" IN ('cosine')),
	CONSTRAINT "junior_memory_embeddings_dimensions_check" CHECK ("junior_memory_embeddings"."dimensions" IN (1024, 1536) AND vector_dims("junior_memory_embeddings"."embedding") = "junior_memory_embeddings"."dimensions")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "junior_memory_signals" (
	"memory_id" text NOT NULL,
	"signal" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"conversation_id" text,
	"observed_at_ms" bigint NOT NULL,
	CONSTRAINT "junior_memory_signals_memory_id_signal_idempotency_key_pk" PRIMARY KEY("memory_id","signal","idempotency_key"),
	CONSTRAINT "junior_memory_signals_memory_id_junior_memory_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."junior_memory_memories"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "junior_memory_signals_signal_check" CHECK ("junior_memory_signals"."signal" IN ('duplicate'))
);
