ALTER TABLE "junior_agent_invocations" ADD COLUMN "fork" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Fork was an agent type. It is now the `fork` column, and the child has no
-- type. The old runtime can still write the `fork` type while `junior upgrade`
-- runs; the new runtime starts those children without the parent's history.
-- junior:bounded-backfill: changes only agent invocations of fork children, which are few and mostly finished, so few live rows match.
UPDATE "junior_agent_invocations"
SET "fork" = true, "agent_type" = NULL
WHERE "agent_type" = 'fork';
