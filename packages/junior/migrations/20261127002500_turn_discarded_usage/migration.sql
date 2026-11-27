ALTER TABLE "junior_turns" ADD COLUMN "discarded_cost_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_turns" ADD COLUMN "discarded_tokens" jsonb;