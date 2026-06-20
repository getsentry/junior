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
  archive_reason TEXT,
  CONSTRAINT junior_memory_memories_scope_check
    CHECK (scope IN ('personal', 'conversation')),
  CONSTRAINT junior_memory_memories_type_check
    CHECK (
      type IN (
        'preference',
        'identity',
        'relationship',
        'knowledge',
        'context',
        'event',
        'task',
        'observation'
      )
    ),
  CONSTRAINT junior_memory_memories_sensitivity_check
    CHECK (sensitivity IN ('public', 'personal', 'sensitive')),
  CONSTRAINT junior_memory_memories_source_platform_check
    CHECK (source_platform IN ('slack', 'local'))
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
