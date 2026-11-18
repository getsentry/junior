CREATE TABLE "junior_turn_inbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_identity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "junior_turn_inbox_kind_check" CHECK ("junior_turn_inbox"."kind" in ('message', 'account_connected')),
	CONSTRAINT "junior_turn_inbox_payload_check" CHECK (jsonb_typeof("junior_turn_inbox"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "junior_turn_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"turn_id" uuid NOT NULL,
	"event_seq" integer NOT NULL,
	"location" jsonb NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "junior_turn_outbox_state_check" CHECK ("junior_turn_outbox"."state" in ('pending', 'sent', 'failed')),
	CONSTRAINT "junior_turn_outbox_sent_check" CHECK (("junior_turn_outbox"."state" = 'sent') = ("junior_turn_outbox"."sent_at" is not null)),
	CONSTRAINT "junior_turn_outbox_attempts_check" CHECK ("junior_turn_outbox"."attempts" >= 0),
	CONSTRAINT "junior_turn_outbox_location_check" CHECK (jsonb_typeof("junior_turn_outbox"."location") = 'object')
);
--> statement-breakpoint
CREATE TABLE "junior_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"actor_identity_id" text NOT NULL,
	"state" text NOT NULL,
	"step_seq" integer DEFAULT 0 NOT NULL,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "junior_turns_state_check" CHECK ("junior_turns"."state" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "junior_turns_lease_check" CHECK (("junior_turns"."state" = 'running') = ("junior_turns"."lease_owner" is not null) and ("junior_turns"."state" = 'running') = ("junior_turns"."lease_expires_at" is not null)),
	CONSTRAINT "junior_turns_ended_check" CHECK (("junior_turns"."state" in ('completed', 'failed', 'cancelled')) = ("junior_turns"."ended_at" is not null)),
	CONSTRAINT "junior_turns_counters_check" CHECK ("junior_turns"."step_seq" >= 0 and "junior_turns"."lease_epoch" >= 0 and "junior_turns"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" ADD CONSTRAINT "junior_turn_inbox_actor_identity_id_junior_identities_id_fk" FOREIGN KEY ("actor_identity_id") REFERENCES "public"."junior_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" ADD CONSTRAINT "junior_turn_inbox_turn_id_junior_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."junior_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" ADD CONSTRAINT "junior_turn_inbox_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_turn_outbox" ADD CONSTRAINT "junior_turn_outbox_turn_id_junior_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."junior_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_turn_outbox" ADD CONSTRAINT "junior_turn_outbox_event_fk" FOREIGN KEY ("conversation_id","event_seq") REFERENCES "public"."junior_conversation_events"("conversation_id","seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_turns" ADD CONSTRAINT "junior_turns_actor_identity_id_junior_identities_id_fk" FOREIGN KEY ("actor_identity_id") REFERENCES "public"."junior_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_turns" ADD CONSTRAINT "junior_turns_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_turn_inbox_idempotency_idx" ON "junior_turn_inbox" USING btree ("conversation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "junior_turn_inbox_pending_idx" ON "junior_turn_inbox" USING btree ("conversation_id","created_at") WHERE "junior_turn_inbox"."turn_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_turn_outbox_event_idx" ON "junior_turn_outbox" USING btree ("conversation_id","event_seq");--> statement-breakpoint
CREATE INDEX "junior_turn_outbox_pending_idx" ON "junior_turn_outbox" USING btree ("created_at") WHERE "junior_turn_outbox"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "junior_turns_active_conversation_idx" ON "junior_turns" USING btree ("conversation_id") WHERE "junior_turns"."state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "junior_turns_running_lease_idx" ON "junior_turns" USING btree ("lease_expires_at") WHERE "junior_turns"."state" = 'running';--> statement-breakpoint
CREATE INDEX "junior_turns_queued_updated_idx" ON "junior_turns" USING btree ("updated_at") WHERE "junior_turns"."state" = 'queued';