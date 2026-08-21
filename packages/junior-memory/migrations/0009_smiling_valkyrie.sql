ALTER TABLE "junior_memory_memories" DROP CONSTRAINT "junior_memory_memories_scope_check";--> statement-breakpoint
WITH target_rows AS (
  SELECT
    id,
    CASE
      WHEN scope = 'conversation'
        AND source_platform = 'slack'
        AND scope_key = 'slack:' || split_part(source_key, ':', 2)
        THEN 'public'
      ELSE 'private'
    END AS target_scope,
    CASE
      WHEN scope = 'conversation'
        AND source_platform = 'slack'
        AND scope_key = 'slack:' || split_part(source_key, ':', 2)
        THEN 'public'
      WHEN source_platform = 'slack'
        THEN regexp_replace(source_key, ':[^:]+$', '')
      ELSE source_key
    END AS target_scope_key,
    row_number() OVER (
      PARTITION BY
        CASE
          WHEN scope = 'conversation'
            AND source_platform = 'slack'
            AND scope_key = 'slack:' || split_part(source_key, ':', 2)
            THEN 'public'
          ELSE 'private'
        END,
        CASE
          WHEN scope = 'conversation'
            AND source_platform = 'slack'
            AND scope_key = 'slack:' || split_part(source_key, ':', 2)
            THEN 'public'
          WHEN source_platform = 'slack'
            THEN regexp_replace(source_key, ':[^:]+$', '')
          ELSE source_key
        END,
        idempotency_key
      ORDER BY id
    ) AS duplicate_rank
  FROM junior_memory_memories
  WHERE idempotency_key IS NOT NULL
    AND archived_at_ms IS NULL
    AND superseded_at_ms IS NULL
    AND superseded_by_id IS NULL
)
UPDATE junior_memory_memories
SET idempotency_key = 'legacy-visibility:' || junior_memory_memories.id
FROM target_rows
WHERE junior_memory_memories.id = target_rows.id
  AND target_rows.duplicate_rank > 1;--> statement-breakpoint
UPDATE junior_memory_memories
SET
  scope = CASE
    WHEN scope = 'conversation'
      AND source_platform = 'slack'
      AND scope_key = 'slack:' || split_part(source_key, ':', 2)
      THEN 'public'
    ELSE 'private'
  END,
  scope_key = CASE
    WHEN scope = 'conversation'
      AND source_platform = 'slack'
      AND scope_key = 'slack:' || split_part(source_key, ':', 2)
      THEN 'public'
    WHEN source_platform = 'slack'
      THEN regexp_replace(source_key, ':[^:]+$', '')
    ELSE source_key
  END;--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD CONSTRAINT "junior_memory_memories_scope_check" CHECK ("junior_memory_memories"."scope" IN ('private', 'public'));
