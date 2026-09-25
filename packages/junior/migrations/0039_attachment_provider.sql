DROP INDEX "junior_attachments_gc_idx";--> statement-breakpoint
ALTER TABLE "junior_attachments" RENAME COLUMN "provider" TO "storage_provider";--> statement-breakpoint
ALTER TABLE "junior_attachments" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "junior_attachments" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "junior_attachments" ADD COLUMN "vision_summary" text;--> statement-breakpoint
CREATE INDEX "junior_attachments_provider_idx" ON "junior_attachments" USING btree ("conversation_id","provider","provider_id");--> statement-breakpoint
CREATE INDEX "junior_attachments_gc_idx" ON "junior_attachments" USING btree ("storage_provider","delete_requested_at","created_at");
