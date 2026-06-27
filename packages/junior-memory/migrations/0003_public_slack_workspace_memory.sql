UPDATE junior_memory_memories
SET idempotency_key = 'legacy-public-slack:' || id
WHERE scope = 'conversation'
  AND source_platform = 'slack'
  AND idempotency_key IS NOT NULL
  AND split_part(scope_key, ':', 1) = 'slack'
  AND split_part(scope_key, ':', 3) LIKE 'C%'
  AND split_part(scope_key, ':', 4) <> '';
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
