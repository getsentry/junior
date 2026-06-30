CREATE TABLE IF NOT EXISTS junior_scheduler_tasks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL,
  next_run_at_ms BIGINT,
  run_now_at_ms BIGINT,
  created_at_ms BIGINT NOT NULL,
  record JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS junior_scheduler_tasks_team_status_idx
  ON junior_scheduler_tasks (team_id, created_at_ms, id)
  WHERE status <> 'deleted';

CREATE INDEX IF NOT EXISTS junior_scheduler_tasks_run_now_due_idx
  ON junior_scheduler_tasks (run_now_at_ms, created_at_ms, id)
  WHERE status = 'active' AND run_now_at_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS junior_scheduler_tasks_next_run_due_idx
  ON junior_scheduler_tasks (next_run_at_ms, created_at_ms, id)
  WHERE status = 'active' AND next_run_at_ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS junior_scheduler_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_for_ms BIGINT NOT NULL,
  record JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS junior_scheduler_runs_task_status_idx
  ON junior_scheduler_runs (task_id, status, scheduled_for_ms);

CREATE INDEX IF NOT EXISTS junior_scheduler_runs_status_idx
  ON junior_scheduler_runs (status, scheduled_for_ms);
