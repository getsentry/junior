-- Busy databases can build this index concurrently first. See src/db/README.md.
DO $$
BEGIN
  -- Even CREATE INDEX IF NOT EXISTS takes a write-blocking table lock.
  IF to_regclass('junior_conversation_events_plugin_report_idx') IS NULL THEN
    CREATE INDEX "junior_conversation_events_plugin_report_idx" ON "junior_conversation_events" USING btree (("payload"->>'namespace'),("payload"->>'name'),"created_at") WHERE "junior_conversation_events"."type" = 'structured_event';
  END IF;

  -- A failed concurrent build can leave an index that exists but cannot be used.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'junior_conversation_events_plugin_report_idx'::regclass
      AND indrelid = 'junior_conversation_events'::regclass
      AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'The plugin report index is not valid and ready. Repair the concurrent build before running junior upgrade.';
  END IF;
END $$;
