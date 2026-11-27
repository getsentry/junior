ALTER TABLE "junior_conversation_events" ADD COLUMN "turn_id" uuid;--> statement-breakpoint
ALTER TABLE "junior_turns" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
-- The column is new, so every row is null and passes the constraint. NOT
-- VALID skips the scan under lock and still checks every new write.
ALTER TABLE "junior_conversation_events" ADD CONSTRAINT "junior_conversation_events_turn_id_junior_turns_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "junior_turns"("id") ON DELETE SET NULL NOT VALID;