ALTER TABLE "junior_conversation_events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_conversation_events_idempotency_idx" ON "junior_conversation_events" USING btree ("conversation_id","idempotency_key");--> statement-breakpoint
DROP VIEW "junior_agent_steps";--> statement-breakpoint
DROP FUNCTION "junior_agent_steps_insert_compat"();--> statement-breakpoint
DROP FUNCTION "junior_agent_steps_delete_compat"();
