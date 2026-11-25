-- Without statistics on this expression, the planner takes each UTC day as
-- distinct as `occurred_at`, so it sorts every metric row to group by day and
-- Identity, and the sort spills to disk. With them it hashes the few groups.
-- readPersonSpendDays groups by this exact expression. ANALYZE fills the
-- statistics now instead of at the next autovacuum; it reads a sample and does
-- not block reads or writes.
CREATE STATISTICS IF NOT EXISTS "junior_conversation_metrics_utc_day_actor"
  ON (date_trunc('day', "occurred_at" AT TIME ZONE 'UTC')), "actor_identity_id"
  FROM "junior_conversation_metrics";
--> statement-breakpoint
ANALYZE "junior_conversation_metrics";
