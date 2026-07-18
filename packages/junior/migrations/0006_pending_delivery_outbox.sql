CREATE TABLE "junior_pending_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"command_json" jsonb NOT NULL,
	"progress_json" jsonb NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	CONSTRAINT "junior_pending_deliveries_lease_version_check" CHECK ("junior_pending_deliveries"."lease_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "junior_pending_deliveries" ADD CONSTRAINT "junior_pending_deliveries_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_pending_deliveries_conversation_idx" ON "junior_pending_deliveries" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "junior_pending_deliveries_due_idx" ON "junior_pending_deliveries" USING btree ("next_attempt_at");