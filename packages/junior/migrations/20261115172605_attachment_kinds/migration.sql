CREATE TABLE "junior_message_attachments" (
	"conversation_id" text NOT NULL,
	"seq" integer NOT NULL,
	"attachment_id" text NOT NULL,
	"position" integer,
	CONSTRAINT "junior_message_attachments_pk" PRIMARY KEY("conversation_id","seq","attachment_id")
);
--> statement-breakpoint
ALTER TABLE "junior_attachments" ALTER COLUMN "storage_provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_attachments" ALTER COLUMN "filename" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_attachments" ALTER COLUMN "content_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_attachments" ALTER COLUMN "bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_attachments" ADD COLUMN "kind" text DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_attachments" ADD COLUMN "url" text;