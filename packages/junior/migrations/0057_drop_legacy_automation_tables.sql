DROP TABLE "junior_task_executions" CASCADE;--> statement-breakpoint
DROP TABLE "junior_event_tasks" CASCADE;--> statement-breakpoint
DROP TABLE "junior_scheduler_runs" CASCADE;--> statement-breakpoint
DROP TABLE "junior_scheduler_tasks" CASCADE;--> statement-breakpoint
-- Dropping junior_scheduler_tasks drops its trigger but not the function.
DROP FUNCTION IF EXISTS "junior_scheduler_assign_creator_identity"();
-- The snapshot no longer has junior_automation_versions.kind, the
-- junior_conversations origin_* columns, or junior_conversations_origin_idx.
-- They stay in the database for one release. Old workers still name them in
-- every insert while this migration runs. Migration 0058 drops them.
