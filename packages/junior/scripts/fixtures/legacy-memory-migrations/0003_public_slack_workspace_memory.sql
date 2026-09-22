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
--> statement-breakpoint
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
