ALTER TABLE "junior_task_executions" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_task_executions" ADD COLUMN "status" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_task_executions" ADD CONSTRAINT "junior_task_executions_status_check" CHECK ("junior_task_executions"."status" in ('blocked', 'completed', 'failed'));
