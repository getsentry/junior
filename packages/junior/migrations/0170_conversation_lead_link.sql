-- NOT VALID: the new column is null in every row, so the FK skips the scan
-- under lock and still holds for every new write. 0171 validates it.
ALTER TABLE "junior_conversations" ADD COLUMN "lead_conversation_id" text;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_lead_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("lead_conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE set null ON UPDATE no action NOT VALID;
