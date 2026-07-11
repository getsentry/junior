CREATE TABLE "junior_scheduler_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"status" text NOT NULL,
	"scheduled_for_ms" bigint NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "junior_scheduler_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"status" text NOT NULL,
	"next_run_at_ms" bigint,
	"run_now_at_ms" bigint,
	"created_at_ms" bigint NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "junior_scheduler_runs_task_status_idx" ON "junior_scheduler_runs" USING btree ("task_id","status","scheduled_for_ms");--> statement-breakpoint
CREATE INDEX "junior_scheduler_runs_status_idx" ON "junior_scheduler_runs" USING btree ("status","scheduled_for_ms");--> statement-breakpoint
CREATE INDEX "junior_scheduler_tasks_team_status_idx" ON "junior_scheduler_tasks" USING btree ("team_id","created_at_ms","id") WHERE "junior_scheduler_tasks"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX "junior_scheduler_tasks_run_now_due_idx" ON "junior_scheduler_tasks" USING btree ("run_now_at_ms","created_at_ms","id") WHERE "junior_scheduler_tasks"."status" = 'active' AND "junior_scheduler_tasks"."run_now_at_ms" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "junior_scheduler_tasks_next_run_due_idx" ON "junior_scheduler_tasks" USING btree ("next_run_at_ms","created_at_ms","id") WHERE "junior_scheduler_tasks"."status" = 'active' AND "junior_scheduler_tasks"."next_run_at_ms" IS NOT NULL;