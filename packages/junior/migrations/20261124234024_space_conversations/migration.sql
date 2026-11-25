ALTER TABLE "junior_conversations" ADD COLUMN "space_id" text;--> statement-breakpoint
-- The column is new, so every row is null and passes both constraints. NOT
-- VALID skips the scan under lock and still checks every new write.
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_space_id_junior_spaces_id_fkey" FOREIGN KEY ("space_id") REFERENCES "junior_spaces"("id") NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_space_root_check" CHECK ("space_id" is null or "parent_conversation_id" is null) NOT VALID;
