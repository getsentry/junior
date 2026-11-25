ALTER TABLE "junior_conversations" ADD COLUMN "requester_identity_id" text;--> statement-breakpoint
-- The column is new, so every row is null and passes the constraint. NOT
-- VALID skips the scan under lock and still checks every new write.
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_Rm7gnfSYomYZ_fkey" FOREIGN KEY ("requester_identity_id") REFERENCES "junior_identities"("id") NOT VALID;
