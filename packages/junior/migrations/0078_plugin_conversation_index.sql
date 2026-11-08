-- Before this migration runs, junior upgrade builds the marked index with
-- CREATE INDEX CONCURRENTLY, so the build below does not block writes.
DO $$
BEGIN
  -- Even CREATE INDEX IF NOT EXISTS takes a write-blocking table lock.
  IF to_regclass('junior_conversation_events_plugin_conversation_idx') IS NULL THEN
    -- junior:concurrent-index
    CREATE INDEX "junior_conversation_events_plugin_conversation_idx" ON "junior_conversation_events" USING btree ("conversation_id",("payload"->>'namespace'),("payload"->>'name'),"seq") WHERE "junior_conversation_events"."type" = 'structured_event';
  END IF;

  -- A failed concurrent build can leave an index that exists but cannot be used.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'junior_conversation_events_plugin_conversation_idx'::regclass
      AND indrelid = 'junior_conversation_events'::regclass
      AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'The plugin conversation index is not valid and ready. Repair the concurrent build before running junior upgrade.';
  END IF;
END $$;
