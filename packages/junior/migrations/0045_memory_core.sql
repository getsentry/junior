-- Memory moved from the @sentry/junior-memory plugin into core.
--
-- This migration adopts the Memory schema in one core journal entry. Every
-- step checks the current database state first, so a fresh database, a fully
-- migrated legacy database, and every partial legacy prefix reach the same
-- final schema without replaying data rewrites that already ran.
CREATE EXTENSION IF NOT EXISTS vector;
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
	"archive_reason" text,
	CONSTRAINT "junior_memory_memories_scope_check" CHECK ("junior_memory_memories"."scope" IN ('private', 'public')),
	CONSTRAINT "junior_memory_memories_kind_check" CHECK ("junior_memory_memories"."type" IN (
        'preference',
        'procedure',
        'knowledge'
      )),
	CONSTRAINT "junior_memory_memories_subject_type_check" CHECK ("junior_memory_memories"."subject_type" IN ('user', 'conversation', 'general')),
	CONSTRAINT "junior_memory_memories_subject_key_check" CHECK (("junior_memory_memories"."subject_type" = 'general' AND "junior_memory_memories"."subject_key" IS NULL) OR ("junior_memory_memories"."subject_type" IN ('user', 'conversation') AND "junior_memory_memories"."subject_key" IS NOT NULL AND length("junior_memory_memories"."subject_key") > 0)),
	CONSTRAINT "junior_memory_memories_source_platform_check" CHECK ("junior_memory_memories"."source_platform" IN ('slack', 'local', 'web'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "junior_memory_embeddings" (
	"memory_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"metric" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at_ms" bigint NOT NULL,
	CONSTRAINT "junior_memory_embeddings_metric_check" CHECK ("junior_memory_embeddings"."metric" IN ('cosine')),
	CONSTRAINT "junior_memory_embeddings_dimensions_check" CHECK ("junior_memory_embeddings"."dimensions" = 1536),
	CONSTRAINT "junior_memory_embeddings_memory_id_junior_memory_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."junior_memory_memories"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- Legacy plugin history 0001-0011: bring an existing Memory table to the
-- final shape in the original order. Each block runs only when its
-- transition is missing, and data rewrites run only when legacy rows remain.
DO $$
DECLARE
  idempotency_index text;
  search_index text;
  source_platform_check text;
  scope_check text;
BEGIN
  -- 0001: the idempotency index applies only to active rows.
  SELECT indexdef INTO idempotency_index
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'junior_memory_memories_idempotency_idx';
  IF idempotency_index IS NOT NULL
    AND idempotency_index NOT LIKE '%superseded_by_id IS NULL%' THEN
    DROP INDEX "junior_memory_memories_idempotency_idx";
  END IF;

  -- 0003: legacy public Slack memory used channel-scoped keys. Convert them
  -- to workspace keys and resolve active idempotency collisions first.
  IF EXISTS (
    SELECT 1 FROM junior_memory_memories
    WHERE scope = 'conversation'
      AND source_platform = 'slack'
      AND split_part(scope_key, ':', 1) = 'slack'
      AND split_part(scope_key, ':', 3) LIKE 'C%'
      AND split_part(scope_key, ':', 4) <> ''
  ) THEN
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
      AND ranked_active_rows.duplicate_rank > 1;

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
      AND split_part(scope_key, ':', 4) <> '';
  END IF;

  -- 0004: legacy kinds collapse into preference, procedure, and knowledge.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'junior_memory_memories_type_check'
      AND conrelid = 'public.junior_memory_memories'::regclass
  ) THEN
    ALTER TABLE "junior_memory_memories" DROP CONSTRAINT "junior_memory_memories_type_check";
    UPDATE "junior_memory_memories"
    SET "type" = CASE
      WHEN "type" = 'task' THEN 'procedure'
      WHEN "type" IN ('identity', 'relationship', 'context', 'event', 'observation') THEN 'knowledge'
      ELSE "type"
    END;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'junior_memory_memories_kind_check'
      AND conrelid = 'public.junior_memory_memories'::regclass
  ) THEN
    ALTER TABLE "junior_memory_memories" ADD CONSTRAINT "junior_memory_memories_kind_check" CHECK ("junior_memory_memories"."type" IN (
        'preference',
        'procedure',
        'knowledge'
      ));
  END IF;

  -- 0005/0006: full-text search uses a stored generated column and a scoped
  -- GIN index. Drop only the 0005 expression index.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'junior_memory_memories'
      AND column_name = 'search_vector'
  ) THEN
    ALTER TABLE "junior_memory_memories" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;
  END IF;
  SELECT indexdef INTO search_index
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'junior_memory_memories_search_idx';
  IF search_index IS NOT NULL AND search_index NOT LIKE '%search_vector%' THEN
    DROP INDEX "junior_memory_memories_search_idx";
  END IF;

  -- 0008: web is a memory source platform.
  SELECT pg_get_constraintdef(oid) INTO source_platform_check
  FROM pg_constraint
  WHERE conname = 'junior_memory_memories_source_platform_check'
    AND conrelid = 'public.junior_memory_memories'::regclass;
  IF source_platform_check IS NOT NULL AND source_platform_check NOT LIKE '%web%' THEN
    ALTER TABLE "junior_memory_memories" DROP CONSTRAINT "junior_memory_memories_source_platform_check";
    ALTER TABLE "junior_memory_memories" ADD CONSTRAINT "junior_memory_memories_source_platform_check" CHECK ("junior_memory_memories"."source_platform" IN ('slack', 'local', 'web'));
  END IF;

  -- 0009: scope is private or public, rows record their Location, unowned
  -- legacy rows are archived, and collisions keep distinct idempotency keys.
  ALTER TABLE "junior_memory_memories" ADD COLUMN IF NOT EXISTS "location_id" text;
  SELECT pg_get_constraintdef(oid) INTO scope_check
  FROM pg_constraint
  WHERE conname = 'junior_memory_memories_scope_check'
    AND conrelid = 'public.junior_memory_memories'::regclass;
  IF scope_check IS NOT NULL AND scope_check NOT LIKE '%private%' THEN
    ALTER TABLE "junior_memory_memories" DROP CONSTRAINT "junior_memory_memories_scope_check";
  END IF;
  IF EXISTS (
    SELECT 1 FROM junior_memory_memories
    WHERE scope IN ('personal', 'conversation')
  ) THEN
    CREATE TEMP TABLE junior_memory_legacy_owners (
      id text PRIMARY KEY,
      user_id text NOT NULL
    ) ON COMMIT DROP;
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
    CREATE TEMP TABLE junior_memory_scope_targets ON COMMIT DROP AS
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
        memory.scope <> 'personal' AND NOT (
          memory.scope = 'conversation'
            AND memory.source_platform = 'slack'
            AND memory.scope_key = 'slack:' || split_part(memory.source_key, ':', 2)
        )
      ) OR (memory.scope = 'personal' AND owner.user_id IS NULL) AS archive_unowned
    FROM junior_memory_memories AS memory
    LEFT JOIN junior_memory_legacy_owners AS owner ON owner.id = memory.id
    WHERE memory.scope IN ('personal', 'conversation');
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
      AND duplicate_targets.duplicate_rank > 1;
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
    WHERE memory.id = target.id;
    DROP TABLE junior_memory_scope_targets;
    DROP TABLE junior_memory_legacy_owners;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'junior_memory_memories_scope_check'
      AND conrelid = 'public.junior_memory_memories'::regclass
  ) THEN
    ALTER TABLE "junior_memory_memories" ADD CONSTRAINT "junior_memory_memories_scope_check" CHECK ("junior_memory_memories"."scope" IN ('private', 'public'));
  END IF;

  -- 0010: stored memories_captured v2 events use private and public labels.
  IF to_regclass('public.junior_conversation_events') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM junior_conversation_events AS event
    WHERE event.type = 'structured_event'
      AND event.payload->>'namespace' = 'memory'
      AND event.payload->>'name' = 'memories_captured'
      AND (event.payload->>'version') = '2'
      AND jsonb_typeof(event.payload->'content'->'memories') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(event.payload->'content'->'memories') AS memory(value)
        WHERE memory.value->>'scope' IN ('personal', 'conversation')
      )
  ) THEN
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
        FROM jsonb_array_elements(event.payload->'content'->'memories') WITH ORDINALITY AS memory(value, ordinality)
      )
    )
    WHERE event.type = 'structured_event'
      AND event.payload->>'namespace' = 'memory'
      AND event.payload->>'name' = 'memories_captured'
      AND (event.payload->>'version') = '2'
      AND jsonb_typeof(event.payload->'content'->'memories') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(event.payload->'content'->'memories') AS memory(value)
        WHERE memory.value->>'scope' IN ('personal', 'conversation')
      );
  END IF;

  -- 0011: rows record the Conversation where Junior learned them. Backfill
  -- only when the column is new. Current code may store rows without one.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'junior_memory_memories'
      AND column_name = 'conversation_id'
  ) THEN
    ALTER TABLE "junior_memory_memories" ADD COLUMN "conversation_id" text;
    UPDATE "junior_memory_memories"
    SET "conversation_id" = "source_key"
    WHERE "source_platform" IN ('web', 'local');
    UPDATE "junior_memory_memories"
    SET "conversation_id" = 'slack:' || split_part("source_key", ':', 3) || ':' || split_part("source_key", ':', 4)
    WHERE "source_platform" = 'slack';
  END IF;
END
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "junior_memory_memories_idempotency_idx" ON "junior_memory_memories" USING btree ("scope","scope_key","idempotency_key") WHERE "junior_memory_memories"."idempotency_key" IS NOT NULL AND "junior_memory_memories"."archived_at_ms" IS NULL AND "junior_memory_memories"."superseded_at_ms" IS NULL AND "junior_memory_memories"."superseded_by_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_memory_memories_visible_idx" ON "junior_memory_memories" USING btree ("scope","scope_key","created_at_ms" DESC NULLS LAST,"id") WHERE "junior_memory_memories"."archived_at_ms" IS NULL AND "junior_memory_memories"."superseded_at_ms" IS NULL AND "junior_memory_memories"."superseded_by_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_memory_memories_expiration_idx" ON "junior_memory_memories" USING btree ("expires_at_ms") WHERE "junior_memory_memories"."archived_at_ms" IS NULL AND "junior_memory_memories"."expires_at_ms" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_memory_memories_search_idx" ON "junior_memory_memories" USING gin ("scope","scope_key","search_vector") WHERE "junior_memory_memories"."archived_at_ms" IS NULL AND "junior_memory_memories"."superseded_at_ms" IS NULL AND "junior_memory_memories"."superseded_by_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_memory_embeddings_model_idx" ON "junior_memory_embeddings" USING btree ("provider","model","dimensions","metric");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "junior_memory_embeddings_embedding_hnsw_idx" ON "junior_memory_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);
