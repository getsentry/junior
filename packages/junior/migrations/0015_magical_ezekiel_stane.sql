CREATE TABLE "junior_event_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"namespace" text NOT NULL,
	"identifier" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"task_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "junior_event_tasks_team_idx" ON "junior_event_tasks" USING btree ("team_id","created_at_ms","id");--> statement-breakpoint
CREATE INDEX "junior_event_tasks_match_idx" ON "junior_event_tasks" USING btree ("namespace","identifier","created_at_ms","id");
