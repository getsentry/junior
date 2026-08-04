-- Drop the paused scheduled-task status.
-- Finished one-offs and any remaining paused rows become deleted tombstones.
UPDATE "junior_scheduler_tasks"
SET
  "status" = 'deleted',
  "next_run_at_ms" = NULL,
  "run_now_at_ms" = NULL,
  "record" = (
    jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE("record", '{}'::jsonb),
          '{status}',
          '"deleted"'::jsonb,
          true
        ),
        '{updatedAtMs}',
        to_jsonb(
          (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
        ),
        true
      ),
      '{nextRunAtMs}',
      'null'::jsonb,
      true
    ) - 'runNowAtMs'
  )
WHERE "status" = 'paused';
