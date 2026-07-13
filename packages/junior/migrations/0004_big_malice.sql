ALTER TABLE "junior_conversations" ADD COLUMN "execution_model_profile" text;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD COLUMN "execution_reasoning_level" text;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD COLUMN "execution_instructions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD COLUMN "execution_allowed_tool_names" text[];