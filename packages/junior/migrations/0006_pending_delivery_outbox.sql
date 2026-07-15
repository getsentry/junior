CREATE TABLE "junior_pending_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"message_id" text NOT NULL,
	"provider" text NOT NULL,
	"delivery_kind" text NOT NULL,
	"command_json" jsonb NOT NULL,
	"part_states_json" jsonb NOT NULL,
	"next_part_index" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_pending_deliveries_cursor_check" CHECK ("junior_pending_deliveries"."next_part_index" >= 0),
	CONSTRAINT "junior_pending_deliveries_attempt_count_check" CHECK ("junior_pending_deliveries"."attempt_count" >= 0),
	CONSTRAINT "junior_pending_deliveries_lease_version_check" CHECK ("junior_pending_deliveries"."lease_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "junior_pending_deliveries" ADD CONSTRAINT "junior_pending_deliveries_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_pending_deliveries_conversation_turn_idx" ON "junior_pending_deliveries" USING btree ("conversation_id","turn_id");--> statement-breakpoint
CREATE INDEX "junior_pending_deliveries_retry_idx" ON "junior_pending_deliveries" USING btree ("next_attempt_at","delivery_id");