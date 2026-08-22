ALTER TABLE "junior_memory_memories" DROP CONSTRAINT "junior_memory_memories_scope_check";--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD COLUMN "location_id" text;--> statement-breakpoint
CREATE TEMP TABLE junior_memory_legacy_owners (
  id text PRIMARY KEY,
  user_id text NOT NULL
) ON COMMIT DROP;--> statement-breakpoint
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
LEFT JOIN junior_memory_legacy_owners AS owner ON owner.id = memory.id;--> statement-breakpoint
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
ALTER TABLE "junior_memory_memories" ADD CONSTRAINT "junior_memory_memories_scope_check" CHECK ("junior_memory_memories"."scope" IN ('private', 'public'));
