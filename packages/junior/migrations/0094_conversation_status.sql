-- The Turn whose failure is the latest Turn lifecycle end. Conversations
-- whose latest Turn failed before this release keep the status `idle`.
ALTER TABLE "junior_conversations" ADD COLUMN "failed_turn_id" text;--> statement-breakpoint
-- Before this migration runs, junior upgrade builds the marked index with
-- CREATE INDEX CONCURRENTLY, so the build below does not block writes.
DO $$
BEGIN
  -- Even CREATE INDEX IF NOT EXISTS takes a write-blocking table lock.
  IF to_regclass('junior_review_items_open_action_added_by_idx') IS NULL THEN
    -- junior:concurrent-index
    CREATE INDEX "junior_review_items_open_action_added_by_idx" ON "junior_review_items" USING btree ("added_by_conversation_id") WHERE "junior_review_items"."status" = 'open' and "junior_review_items"."kind" = 'action';
  END IF;

  -- A failed concurrent build can leave an index that exists but cannot be used.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'junior_review_items_open_action_added_by_idx'::regclass
      AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'The review item status index is not valid and ready. Repair the concurrent build before running junior upgrade.';
  END IF;
END $$;
