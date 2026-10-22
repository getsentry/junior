-- Scheduled automations no longer store an execution actor. Nothing read it,
-- and the strict record schema rejects the field, so remove it from rows.
UPDATE "junior_automations"
SET "record" = "record" - 'executionActor'
WHERE "kind" = 'scheduled'
	AND "record" -> 'executionActor' IS NOT NULL;
