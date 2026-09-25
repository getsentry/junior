DROP INDEX "junior_event_tasks_team_idx";--> statement-breakpoint
DROP INDEX "junior_event_tasks_match_idx";--> statement-breakpoint
ALTER TABLE "junior_event_tasks" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE INDEX "junior_event_tasks_team_idx" ON "junior_event_tasks" USING btree ("team_id","created_at_ms","id") WHERE "junior_event_tasks"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX "junior_event_tasks_match_idx" ON "junior_event_tasks" USING btree ("namespace","identifier","created_at_ms","id") WHERE "junior_event_tasks"."status" <> 'deleted';