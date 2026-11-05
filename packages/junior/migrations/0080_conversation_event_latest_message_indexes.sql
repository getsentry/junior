-- For a busy database, first run each index definition below with
-- CONCURRENTLY, as one statement outside a transaction. Before junior upgrade,
-- check their pg_get_indexdef, pg_index.indisvalid, and pg_index.indisready.
DO $$
BEGIN
  -- Even CREATE INDEX IF NOT EXISTS takes a write-blocking table lock.
  IF to_regclass('junior_conversation_events_message_role_idx') IS NULL THEN
    CREATE INDEX "junior_conversation_events_message_role_idx" ON "junior_conversation_events" USING btree ("conversation_id",("payload"->>'role'),"created_at","seq") WHERE "junior_conversation_events"."type" = 'message';
  END IF;
  IF to_regclass('junior_conversation_events_user_message_time_idx') IS NULL THEN
    CREATE INDEX "junior_conversation_events_user_message_time_idx" ON "junior_conversation_events" USING btree ("conversation_id","created_at","seq") WHERE "junior_conversation_events"."type" = 'user_message';
  END IF;

  -- A failed concurrent build can leave an index that exists but cannot be used.
  IF (
    SELECT count(*) FROM pg_index
    WHERE indexrelid IN (
        'junior_conversation_events_message_role_idx'::regclass,
        'junior_conversation_events_user_message_time_idx'::regclass
      )
      AND indrelid = 'junior_conversation_events'::regclass
      AND indisvalid AND indisready
  ) <> 2 THEN
    RAISE EXCEPTION 'The conversation event latest message indexes are not valid and ready. Repair the concurrent builds before running junior upgrade.';
  END IF;
END $$;
