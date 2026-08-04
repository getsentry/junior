-- Tombstone finished scheduled tasks that used to linger as paused with no future run.
-- Explicitly paused tasks that still have a next/run-now time stay paused.
UPDATE "junior_scheduler_tasks"
SET
  "status" = 'deleted',
  "record" = jsonb_set(
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
  )
WHERE "status" = 'paused'
  AND "next_run_at_ms" IS NULL
  AND "run_now_at_ms" IS NULL;
