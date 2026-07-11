ALTER TABLE "junior_conversations" ADD COLUMN "duration_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD COLUMN "usage_json" jsonb;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD COLUMN "execution_duration_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD COLUMN "execution_usage_json" jsonb;