CREATE TABLE IF NOT EXISTS junior_memory_memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  type TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  source_key TEXT NOT NULL,
  idempotency_key TEXT,
  observed_at_ms BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT,
  superseded_at_ms BIGINT,
  superseded_by_id TEXT,
  archived_at_ms BIGINT,
  archive_reason TEXT
);

CREATE INDEX IF NOT EXISTS junior_memory_memories_visible_idx
  ON junior_memory_memories (scope, scope_key, created_at_ms DESC, id)
  WHERE archived_at_ms IS NULL AND superseded_at_ms IS NULL AND superseded_by_id IS NULL;

CREATE INDEX IF NOT EXISTS junior_memory_memories_expiration_idx
  ON junior_memory_memories (expires_at_ms)
  WHERE archived_at_ms IS NULL AND expires_at_ms IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS junior_memory_memories_active_hash_idx
  ON junior_memory_memories (scope, scope_key, content_hash)
  WHERE archived_at_ms IS NULL AND superseded_at_ms IS NULL AND superseded_by_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS junior_memory_memories_idempotency_idx
  ON junior_memory_memories (scope, scope_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
