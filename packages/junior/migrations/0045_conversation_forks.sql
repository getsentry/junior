ALTER TABLE "junior_attachments" ADD COLUMN "history_ids" text[];--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD COLUMN "inherited_through_seq" integer DEFAULT -1 NOT NULL;