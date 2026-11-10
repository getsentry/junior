-- Finds the Automations that run a skill. 0096 adds the column; a concurrent
-- build cannot run in that migration's transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_automations_skill_idx" ON "junior_automations" USING btree ("skill","created_at_ms","id") WHERE "junior_automations"."status" <> 'deleted' AND "junior_automations"."skill" IS NOT NULL;
