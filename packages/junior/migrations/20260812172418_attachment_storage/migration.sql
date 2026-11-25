CREATE TABLE "junior_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"delete_requested_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "junior_attachments" ADD CONSTRAINT "junior_attachments_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_attachments_conversation_idx" ON "junior_attachments" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "junior_attachments_gc_idx" ON "junior_attachments" USING btree ("provider","delete_requested_at","created_at");
