ALTER TABLE "junior_conversation_embeddings" DROP COLUMN "brief_version";--> statement-breakpoint
-- 0149 added this FK as NOT VALID. VALIDATE scans the rows under SHARE
-- UPDATE EXCLUSIVE, so reads and writes keep going.
ALTER TABLE "junior_conversation_embeddings" VALIDATE CONSTRAINT "junior_conversation_embeddings_conversation_fk";
