-- Store a paused Conversation by its current name. Readers accept both
-- names until no deployed worker writes awaiting_resume.
UPDATE "junior_conversations" SET "execution_status" = 'paused' WHERE "execution_status" = 'awaiting_resume';
