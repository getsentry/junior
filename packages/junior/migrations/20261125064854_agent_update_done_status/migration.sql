-- Agent updates named an ended Turn `completed` before they named it `done`.
-- Readers now know only `done`, so rewrite the stored status of those
-- Messages.
-- junior:bounded-backfill: only agent update Messages stored by the two releases that wrote `completed`; the update sets one payload field.
UPDATE "junior_conversation_events"
SET "payload" = jsonb_set("payload", '{meta,eventStatus}', '"done"')
WHERE "type" = 'message'
  AND "payload"->'meta'->>'eventType' = 'agent.update'
  AND "payload"->'meta'->>'eventStatus' = 'completed';
