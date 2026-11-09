DROP INDEX "junior_attachments_gc_idx";--> statement-breakpoint
ALTER TABLE "junior_attachments" ADD COLUMN "status" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_attachments" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL;--> statement-breakpoint
-- Status was implied by delete_requested_at, and expiry by created_at.
UPDATE "junior_attachments" SET "status" = 'delete_requested' WHERE "delete_requested_at" IS NOT NULL;--> statement-breakpoint
UPDATE "junior_attachments" SET "expires_at" = "created_at" + interval '30 days';--> statement-breakpoint
CREATE INDEX "junior_attachments_gc_idx" ON "junior_attachments" USING btree ("storage_provider","status","expires_at");--> statement-breakpoint
ALTER TABLE "junior_attachments" ADD CONSTRAINT "junior_attachments_status_check" CHECK ("junior_attachments"."status" in ('live', 'delete_requested'));
