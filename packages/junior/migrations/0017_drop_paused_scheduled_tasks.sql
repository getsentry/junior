-- Drop the paused scheduled-task status.
-- Finished one-offs and any remaining paused rows become deleted tombstones.
UPDATE "junior_scheduler_tasks"
SET
  "status" = 'deleted',
  "next_run_at_ms" = NULL,
  "run_now_at_ms" = NULL,
  "record" = (
    (
      COALESCE("record", '{}'::jsonb)
      - 'nextRunAtMs'
      - 'runNowAtMs'
    )
    || jsonb_build_object(
      'status', 'deleted',
      'updatedAtMs', (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
    )
  )
WHERE "status" = 'paused';
