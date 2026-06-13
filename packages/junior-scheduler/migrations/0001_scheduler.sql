CREATE TABLE IF NOT EXISTS junior_scheduler_tasks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL,
  next_run_at_ms BIGINT,
  run_now_at_ms BIGINT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  version INTEGER NOT NULL,
  destination JSONB NOT NULL,
  created_by JSONB NOT NULL,
  conversation_access JSONB,
  credential_subject JSONB,
  execution_actor JSONB,
  last_run_at_ms BIGINT,
  original_request TEXT,
  schedule JSONB NOT NULL,
  status_reason TEXT,
  task JSONB NOT NULL,
  record JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS junior_scheduler_tasks_team_status_idx
  ON junior_scheduler_tasks (team_id, status, created_at_ms);

CREATE INDEX IF NOT EXISTS junior_scheduler_tasks_due_idx
  ON junior_scheduler_tasks (status, run_now_at_ms, next_run_at_ms);

CREATE TABLE IF NOT EXISTS junior_scheduler_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_at_ms BIGINT NOT NULL,
  scheduled_for_ms BIGINT NOT NULL,
  started_at_ms BIGINT,
  completed_at_ms BIGINT,
  dispatch_id TEXT,
  error_message TEXT,
  idempotency_key TEXT NOT NULL,
  result_message_ts TEXT,
  task_version INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  record JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS junior_scheduler_runs_task_status_idx
  ON junior_scheduler_runs (task_id, status, scheduled_for_ms);

CREATE INDEX IF NOT EXISTS junior_scheduler_runs_status_idx
  ON junior_scheduler_runs (status, scheduled_for_ms);
