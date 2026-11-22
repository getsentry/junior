-- 0149 added this FK as NOT VALID. VALIDATE CONSTRAINT takes only SHARE UPDATE
-- EXCLUSIVE, so reads and writes keep going during the scan. Keep it alone in
-- this migration: each migration runs in one transaction, and a stronger lock
-- in the same file would be held for the whole scan.
ALTER TABLE "junior_conversation_embeddings" VALIDATE CONSTRAINT "junior_conversation_embeddings_conversation_fk";
