ALTER TABLE "junior_conversations" ADD COLUMN "metric_run_id" text;--> statement-breakpoint
UPDATE "junior_conversations"
SET "metric_run_id" = "run_id"
WHERE "execution_duration_ms" > 0;