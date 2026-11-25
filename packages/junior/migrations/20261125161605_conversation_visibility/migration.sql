ALTER TABLE "junior_conversations" ADD COLUMN "visibility" text;--> statement-breakpoint
-- The column is new, so every row is null and passes the constraint. NOT
-- VALID skips the scan under lock and still checks every new write.
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_visibility_check" CHECK ("visibility" is null or ("visibility" in ('public', 'private') and "parent_conversation_id" is null)) NOT VALID;
