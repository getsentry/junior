CREATE TABLE "junior_agent_bindings" (
	"parent_conversation_id" text NOT NULL,
	"name" text NOT NULL,
	"child_conversation_id" text NOT NULL,
	CONSTRAINT "junior_agent_bindings_parent_conversation_id_name_pk" PRIMARY KEY("parent_conversation_id","name")
);
--> statement-breakpoint
CREATE TABLE "junior_agent_invocations" (
	"invocation_id" text PRIMARY KEY NOT NULL,
	"parent_conversation_id" text NOT NULL,
	"child_conversation_id" text NOT NULL,
	"agent_name" text,
	"input" text NOT NULL,
	"actor_json" jsonb NOT NULL,
	"credential_context_json" jsonb,
	"source_json" jsonb NOT NULL,
	"destination_json" jsonb NOT NULL,
	"destination_visibility" text,
	"reasoning_level" text,
	"status" text NOT NULL,
	"mailbox_status" text NOT NULL,
	"result" text,
	"error_message" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"terminal_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "junior_agent_bindings" ADD CONSTRAINT "junior_agent_bindings_parent_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("parent_conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_agent_bindings" ADD CONSTRAINT "junior_agent_bindings_child_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("child_conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_agent_invocations" ADD CONSTRAINT "junior_agent_invocations_parent_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("parent_conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_agent_invocations" ADD CONSTRAINT "junior_agent_invocations_child_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("child_conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_agent_bindings_child_idx" ON "junior_agent_bindings" USING btree ("child_conversation_id");--> statement-breakpoint
CREATE INDEX "junior_agent_invocations_child_idx" ON "junior_agent_invocations" USING btree ("child_conversation_id");--> statement-breakpoint
CREATE INDEX "junior_agent_invocations_mailbox_idx" ON "junior_agent_invocations" USING btree ("mailbox_status","created_at");