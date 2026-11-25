CREATE TABLE "junior_turn_inbox" (
	"id" uuid PRIMARY KEY,
	"conversation_id" text NOT NULL,
	"actor_identity_id" text NOT NULL,
	"source" jsonb NOT NULL,
	"destination" jsonb,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"trace_context" jsonb,
	"turn_id" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"attempted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "junior_turn_inbox_payload_check" CHECK (jsonb_typeof("payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "junior_turn_outbox" (
	"id" uuid PRIMARY KEY,
	"conversation_id" text NOT NULL,
	"turn_id" uuid NOT NULL,
	"event_seq" integer NOT NULL,
	"destination" jsonb NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "junior_turn_outbox_state_check" CHECK ("state" in ('pending', 'sent', 'failed')),
	CONSTRAINT "junior_turn_outbox_sent_check" CHECK (("state" = 'sent') = ("sent_at" is not null)),
	CONSTRAINT "junior_turn_outbox_attempts_check" CHECK ("attempts" >= 0),
	CONSTRAINT "junior_turn_outbox_destination_check" CHECK (jsonb_typeof("destination") = 'object')
);
--> statement-breakpoint
CREATE TABLE "junior_turns" (
	"id" uuid PRIMARY KEY,
	"conversation_id" text NOT NULL,
	"actor_identity_id" text NOT NULL,
	"state" text NOT NULL,
	"priority" integer NOT NULL,
	"step_seq" integer DEFAULT 0 NOT NULL,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"end_reason" text,
	"failure_code" text,
	"failure_reason" text,
	"failure_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "junior_turns_state_check" CHECK ("state" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "junior_turns_lease_check" CHECK (("state" = 'running') = ("lease_owner" is not null) and ("state" = 'running') = ("lease_expires_at" is not null)),
	CONSTRAINT "junior_turns_ended_check" CHECK (("state" in ('completed', 'failed', 'cancelled')) = ("ended_at" is not null)),
	CONSTRAINT "junior_turns_counters_check" CHECK ("step_seq" >= 0 and "lease_epoch" >= 0 and "attempts" >= 0),
	CONSTRAINT "junior_turns_priority_check" CHECK ("priority" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "junior_turn_inbox_idempotency_idx" ON "junior_turn_inbox" ("conversation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "junior_turn_inbox_turn_idx" ON "junior_turn_inbox" ("turn_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "junior_turn_outbox_event_idx" ON "junior_turn_outbox" ("conversation_id","event_seq");--> statement-breakpoint
CREATE INDEX "junior_turn_outbox_pending_idx" ON "junior_turn_outbox" ("created_at") WHERE "state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "junior_turns_running_conversation_idx" ON "junior_turns" ("conversation_id") WHERE "state" = 'running';--> statement-breakpoint
CREATE INDEX "junior_turns_queued_priority_idx" ON "junior_turns" ("conversation_id","priority","created_at") WHERE "state" = 'queued';--> statement-breakpoint
CREATE INDEX "junior_turns_running_lease_idx" ON "junior_turns" ("lease_expires_at") WHERE "state" = 'running';--> statement-breakpoint
CREATE INDEX "junior_turns_queued_updated_idx" ON "junior_turns" ("updated_at") WHERE "state" = 'queued';--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" ADD CONSTRAINT "junior_turn_inbox_actor_identity_id_junior_identities_id_fkey" FOREIGN KEY ("actor_identity_id") REFERENCES "junior_identities"("id");--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" ADD CONSTRAINT "junior_turn_inbox_turn_id_junior_turns_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "junior_turns"("id");--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" ADD CONSTRAINT "junior_turn_inbox_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "junior_conversations"("conversation_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "junior_turn_outbox" ADD CONSTRAINT "junior_turn_outbox_turn_id_junior_turns_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "junior_turns"("id");--> statement-breakpoint
ALTER TABLE "junior_turn_outbox" ADD CONSTRAINT "junior_turn_outbox_event_fk" FOREIGN KEY ("conversation_id","event_seq") REFERENCES "junior_conversation_events"("conversation_id","seq") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "junior_turns" ADD CONSTRAINT "junior_turns_actor_identity_id_junior_identities_id_fkey" FOREIGN KEY ("actor_identity_id") REFERENCES "junior_identities"("id");--> statement-breakpoint
ALTER TABLE "junior_turns" ADD CONSTRAINT "junior_turns_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "junior_conversations"("conversation_id") ON DELETE CASCADE;