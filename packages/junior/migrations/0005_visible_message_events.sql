ALTER TABLE "junior_conversation_events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_conversation_events_idempotency_idx" ON "junior_conversation_events" USING btree ("conversation_id","idempotency_key");
