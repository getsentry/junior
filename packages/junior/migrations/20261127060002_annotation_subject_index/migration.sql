CREATE INDEX CONCURRENTLY IF NOT EXISTS "junior_conversation_annotations_subject_idx" ON "junior_conversation_annotations" ("subject_kind","subject_id","created_at") WHERE "subject_kind" is not null;
