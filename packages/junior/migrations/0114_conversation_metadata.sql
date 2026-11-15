ALTER TABLE "junior_conversation_embeddings" DROP CONSTRAINT "junior_conversation_embeddings_brief_fk";
--> statement-breakpoint
ALTER TABLE "junior_conversation_embeddings" ALTER COLUMN "brief_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_conversation_embeddings" ADD COLUMN "through_seq" integer;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD COLUMN "outcome_status" text;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD COLUMN "metadata_through_seq" integer;--> statement-breakpoint
-- Every embedding belonged to a Brief of an existing Conversation, so every
-- row passes. NOT VALID skips the scan under lock and still checks every new
-- write.
ALTER TABLE "junior_conversation_embeddings" ADD CONSTRAINT "junior_conversation_embeddings_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action NOT VALID;
