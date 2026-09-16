-- Adopt the former Memory plugin tables without copying or renaming data.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "junior_memory_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_key" text,
	"content" text NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED,
	"source_platform" text NOT NULL,
	"source_key" text NOT NULL,
	"location_id" text,
	"conversation_id" text,
	"idempotency_key" text,
	"observed_at_ms" bigint NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"expires_at_ms" bigint,
	"superseded_at_ms" bigint,
	"superseded_by_id" text,
	"archived_at_ms" bigint,
	"archive_reason" text
);--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD COLUMN IF NOT EXISTS "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD COLUMN IF NOT EXISTS "location_id" text;--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD COLUMN IF NOT EXISTS "conversation_id" text;--> statement-breakpoint
ALTER TABLE "junior_memory_memories" DROP CONSTRAINT IF EXISTS "junior_memory_memories_scope_check";--> statement-breakpoint
ALTER TABLE "junior_memory_memories" DROP CONSTRAINT IF EXISTS "junior_memory_memories_type_check";--> statement-breakpoint
ALTER TABLE "junior_memory_memories" DROP CONSTRAINT IF EXISTS "junior_memory_memories_kind_check";--> statement-breakpoint
ALTER TABLE "junior_memory_memories" DROP CONSTRAINT IF EXISTS "junior_memory_memories_subject_type_check";--> statement-breakpoint
ALTER TABLE "junior_memory_memories" DROP CONSTRAINT IF EXISTS "junior_memory_memories_subject_key_check";--> statement-breakpoint
ALTER TABLE "junior_memory_memories" DROP CONSTRAINT IF EXISTS "junior_memory_memories_source_platform_check";--> statement-breakpoint
UPDATE "junior_memory_memories"
SET "type" = CASE
	WHEN "type" = 'task' THEN 'procedure'
	WHEN "type" IN ('identity', 'relationship', 'context', 'event', 'observation') THEN 'knowledge'
	ELSE "type"
END;--> statement-breakpoint
WITH ranked_active_rows AS (
	SELECT
		id,
		is_legacy_public,
		row_number() OVER (
			PARTITION BY target_scope_key, idempotency_key
			ORDER BY CASE WHEN is_legacy_public THEN 1 ELSE 0 END, id
		) AS duplicate_rank
	FROM (
		SELECT
			id,
			idempotency_key,
			CASE
				WHEN split_part(scope_key, ':', 1) = 'slack'
					AND split_part(scope_key, ':', 3) LIKE 'C%'
					AND split_part(scope_key, ':', 4) <> ''
					THEN 'slack:' || split_part(scope_key, ':', 2)
				ELSE scope_key
			END AS target_scope_key,
			split_part(scope_key, ':', 1) = 'slack'
				AND split_part(scope_key, ':', 3) LIKE 'C%'
				AND split_part(scope_key, ':', 4) <> '' AS is_legacy_public
		FROM junior_memory_memories
		WHERE scope = 'conversation'
			AND source_platform = 'slack'
			AND idempotency_key IS NOT NULL
			AND archived_at_ms IS NULL
			AND superseded_at_ms IS NULL
			AND superseded_by_id IS NULL
	) active_rows
)
UPDATE junior_memory_memories
SET idempotency_key = 'legacy-public-slack:' || junior_memory_memories.id
FROM ranked_active_rows
WHERE junior_memory_memories.id = ranked_active_rows.id
	AND ranked_active_rows.is_legacy_public
	AND ranked_active_rows.duplicate_rank > 1;--> statement-breakpoint
UPDATE junior_memory_memories
SET
	scope_key = 'slack:' || split_part(scope_key, ':', 2),
	subject_key = CASE
		WHEN subject_type = 'conversation'
			AND subject_key IS NOT NULL
			AND split_part(subject_key, ':', 1) = 'slack'
			AND split_part(subject_key, ':', 3) LIKE 'C%'
			AND split_part(subject_key, ':', 4) <> ''
			THEN 'slack:' || split_part(subject_key, ':', 2)
		ELSE subject_key
	END
WHERE scope = 'conversation'
	AND source_platform = 'slack'
	AND split_part(scope_key, ':', 1) = 'slack'
	AND split_part(scope_key, ':', 3) LIKE 'C%'
	AND split_part(scope_key, ':', 4) <> '';--> statement-breakpoint
CREATE TEMP TABLE junior_memory_legacy_owners (
	id text PRIMARY KEY,
	user_id text NOT NULL
);--> statement-breakpoint
DO $$
BEGIN
	IF to_regclass('junior_identities') IS NOT NULL THEN
		EXECUTE $migration$
			INSERT INTO junior_memory_legacy_owners (id, user_id)
			SELECT memory.id, owner.user_id
			FROM junior_memory_memories AS memory
			INNER JOIN LATERAL (
				SELECT identity.user_id
				FROM junior_identities AS identity
				WHERE identity.user_id IS NOT NULL
					AND (
						(
							memory.scope_key LIKE 'slack:%'
							AND identity.provider = 'slack'
							AND identity.provider_tenant_id = split_part(memory.scope_key, ':', 2)
							AND identity.provider_subject_id = split_part(memory.scope_key, ':', 3)
						)
						OR (
							memory.scope_key LIKE 'local:%'
							AND identity.provider = 'local'
							AND identity.provider_subject_id = substring(memory.scope_key FROM 7)
						)
						OR (
							memory.scope_key LIKE 'junior:%'
							AND identity.provider = 'junior'
							AND identity.provider_subject_id = substring(memory.scope_key FROM 8)
						)
					)
				ORDER BY identity.id
				LIMIT 1
			) AS owner ON memory.scope = 'personal'
		$migration$;
	END IF;
END
$$;--> statement-breakpoint
CREATE TEMP TABLE junior_memory_scope_targets AS
SELECT
	memory.id,
	CASE
		WHEN memory.scope = 'conversation'
			AND memory.source_platform = 'slack'
			AND memory.scope_key = 'slack:' || split_part(memory.source_key, ':', 2)
			THEN 'public'
		ELSE 'private'
	END AS target_scope,
	CASE
		WHEN memory.scope = 'conversation'
			AND memory.source_platform = 'slack'
			AND memory.scope_key = 'slack:' || split_part(memory.source_key, ':', 2)
			THEN 'public'
		WHEN memory.scope = 'personal' AND owner.user_id IS NOT NULL
			THEN owner.user_id
		ELSE 'legacy-unowned:' || memory.id
	END AS target_scope_key,
	(
		memory.scope = 'conversation' AND NOT (
			memory.source_platform = 'slack'
				AND memory.scope_key = 'slack:' || split_part(memory.source_key, ':', 2)
		)
	) OR (memory.scope = 'personal' AND owner.user_id IS NULL) AS archive_unowned
FROM junior_memory_memories AS memory
LEFT JOIN junior_memory_legacy_owners AS owner ON owner.id = memory.id
WHERE memory.scope IN ('personal', 'conversation');--> statement-breakpoint
WITH duplicate_targets AS (
	SELECT
		memory.id,
		row_number() OVER (
			PARTITION BY target.target_scope, target.target_scope_key, memory.idempotency_key
			ORDER BY memory.id
		) AS duplicate_rank
	FROM junior_memory_memories AS memory
	INNER JOIN junior_memory_scope_targets AS target ON target.id = memory.id
	WHERE memory.idempotency_key IS NOT NULL
		AND memory.archived_at_ms IS NULL
		AND memory.superseded_at_ms IS NULL
		AND memory.superseded_by_id IS NULL
		AND NOT target.archive_unowned
)
UPDATE junior_memory_memories AS memory
SET idempotency_key = 'legacy-scope:' || memory.id
FROM duplicate_targets
WHERE memory.id = duplicate_targets.id
	AND duplicate_targets.duplicate_rank > 1;--> statement-breakpoint
UPDATE junior_memory_memories AS memory
SET
	scope = target.target_scope,
	scope_key = target.target_scope_key,
	subject_key = CASE
		WHEN memory.subject_type = 'user' AND target.target_scope = 'private'
			THEN target.target_scope_key
		ELSE memory.subject_key
	END,
	archived_at_ms = CASE
		WHEN target.archive_unowned
			THEN coalesce(memory.archived_at_ms, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
		ELSE memory.archived_at_ms
	END,
	archive_reason = CASE
		WHEN target.archive_unowned
			THEN coalesce(memory.archive_reason, 'legacy_unowned_scope')
		ELSE memory.archive_reason
	END
FROM junior_memory_scope_targets AS target
WHERE memory.id = target.id;--> statement-breakpoint
DROP TABLE junior_memory_scope_targets;--> statement-breakpoint
DROP TABLE junior_memory_legacy_owners;--> statement-breakpoint
UPDATE "junior_memory_memories"
SET "conversation_id" = "source_key"
WHERE "conversation_id" IS NULL
	AND "source_platform" IN ('web', 'local');--> statement-breakpoint
UPDATE "junior_memory_memories"
SET "conversation_id" = 'slack:' || split_part("source_key", ':', 3) || ':' || split_part("source_key", ':', 4)
WHERE "conversation_id" IS NULL
	AND "source_platform" = 'slack';--> statement-breakpoint
DO $$
BEGIN
	IF to_regclass('public.junior_conversation_events') IS NULL THEN
		RETURN;
	END IF;

	UPDATE junior_conversation_events AS event
	SET payload = jsonb_set(
		event.payload,
		'{content,memories}',
		(
			SELECT coalesce(
				jsonb_agg(
					CASE
						WHEN jsonb_typeof(memory.value) = 'object'
							AND memory.value->>'scope' = 'personal'
							THEN jsonb_set(memory.value, '{scope}', '"private"'::jsonb)
						WHEN jsonb_typeof(memory.value) = 'object'
							AND memory.value->>'scope' = 'conversation'
							THEN jsonb_set(memory.value, '{scope}', '"public"'::jsonb)
						ELSE memory.value
					END
					ORDER BY memory.ordinality
				),
				'[]'::jsonb
			)
			FROM jsonb_array_elements(
				CASE
					WHEN jsonb_typeof(event.payload->'content'->'memories') = 'array'
						THEN event.payload->'content'->'memories'
					ELSE '[]'::jsonb
				END
			) WITH ORDINALITY AS memory(value, ordinality)
		)
	)
	WHERE event.type = 'structured_event'
		AND event.payload->>'namespace' = 'memory'
		AND event.payload->>'name' = 'memories_captured'
		AND event.payload->>'version' = '2'
		AND jsonb_typeof(event.payload->'content'->'memories') = 'array'
		AND EXISTS (
			SELECT 1
			FROM jsonb_array_elements(event.payload->'content'->'memories') AS memory(value)
			WHERE memory.value->>'scope' IN ('personal', 'conversation')
		);
END
$$;--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD CONSTRAINT "junior_memory_memories_scope_check" CHECK ("scope" IN ('private', 'public'));--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD CONSTRAINT "junior_memory_memories_kind_check" CHECK ("type" IN ('preference', 'procedure', 'knowledge'));--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD CONSTRAINT "junior_memory_memories_subject_type_check" CHECK ("subject_type" IN ('user', 'conversation', 'general'));--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD CONSTRAINT "junior_memory_memories_subject_key_check" CHECK (("subject_type" = 'general' AND "subject_key" IS NULL) OR ("subject_type" IN ('user', 'conversation') AND "subject_key" IS NOT NULL AND length("subject_key") > 0));--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD CONSTRAINT "junior_memory_memories_source_platform_check" CHECK ("source_platform" IN ('slack', 'local', 'web'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "junior_memory_embeddings" (
	"memory_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"metric" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at_ms" bigint NOT NULL
);--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" DROP CONSTRAINT IF EXISTS "junior_memory_embeddings_metric_check";--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" DROP CONSTRAINT IF EXISTS "junior_memory_embeddings_dimensions_check";--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" ADD CONSTRAINT "junior_memory_embeddings_metric_check" CHECK ("metric" IN ('cosine'));--> statement-breakpoint
ALTER TABLE "junior_memory_embeddings" ADD CONSTRAINT "junior_memory_embeddings_dimensions_check" CHECK ("dimensions" = 1536);--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'junior_memory_embeddings_memory_id_junior_memory_memories_id_fk'
			AND conrelid = 'junior_memory_embeddings'::regclass
	) THEN
		ALTER TABLE "junior_memory_embeddings"
			ADD CONSTRAINT "junior_memory_embeddings_memory_id_junior_memory_memories_id_fk"
			FOREIGN KEY ("memory_id") REFERENCES "public"."junior_memory_memories"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END
$$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_memory_embeddings_model_idx" ON "junior_memory_embeddings" USING btree ("provider","model","dimensions","metric");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_memory_embeddings_embedding_hnsw_idx" ON "junior_memory_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_memory_memories_visible_idx" ON "junior_memory_memories" USING btree ("scope","scope_key","created_at_ms" DESC NULLS LAST,"id") WHERE "archived_at_ms" IS NULL AND "superseded_at_ms" IS NULL AND "superseded_by_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_memory_memories_expiration_idx" ON "junior_memory_memories" USING btree ("expires_at_ms") WHERE "archived_at_ms" IS NULL AND "expires_at_ms" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "junior_memory_memories_search_idx";--> statement-breakpoint
CREATE INDEX "junior_memory_memories_search_idx" ON "junior_memory_memories" USING gin ("scope","scope_key","search_vector") WHERE "archived_at_ms" IS NULL AND "superseded_at_ms" IS NULL AND "superseded_by_id" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "junior_memory_memories_idempotency_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "junior_memory_memories_idempotency_idx" ON "junior_memory_memories" USING btree ("scope","scope_key","idempotency_key") WHERE "idempotency_key" IS NOT NULL AND "archived_at_ms" IS NULL AND "superseded_at_ms" IS NULL AND "superseded_by_id" IS NULL;
