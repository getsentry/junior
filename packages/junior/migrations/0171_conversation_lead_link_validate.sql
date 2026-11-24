-- 0170 added this FK as NOT VALID. VALIDATE CONSTRAINT takes only SHARE UPDATE
-- EXCLUSIVE, so reads and writes keep going during the scan. Keep it alone in
-- this migration: each migration runs in one transaction, and a stronger lock
-- in the same file would be held for the whole scan.
ALTER TABLE "junior_conversations" VALIDATE CONSTRAINT "junior_conversations_lead_conversation_id_junior_conversations_conversation_id_fk";
