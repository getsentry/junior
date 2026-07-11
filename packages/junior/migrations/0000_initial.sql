CREATE TABLE "junior_agent_steps" (
	"conversation_id" text NOT NULL,
	"seq" integer NOT NULL,
	"context_epoch" integer NOT NULL,
	"type" text NOT NULL,
	"role" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_agent_steps_conversation_id_seq_pk" PRIMARY KEY("conversation_id","seq")
);
--> statement-breakpoint
CREATE TABLE "junior_conversation_messages" (
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"role" text NOT NULL,
	"author_identity_id" text,
	"text" text NOT NULL,
	"meta" jsonb,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_conversation_messages_conversation_id_message_id_pk" PRIMARY KEY("conversation_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "junior_conversations" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text,
	"origin_type" text,
	"origin_id" text,
	"origin_run_id" text,
	"destination_id" text,
	"destination_json" jsonb,
	"actor_identity_id" text,
	"creator_identity_id" text,
	"credential_subject_identity_id" text,
	"actor_json" jsonb,
	"channel_name" text,
	"title" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"execution_updated_at" timestamp with time zone,
	"execution_status" text NOT NULL,
	"run_id" text,
	"last_checkpoint_at" timestamp with time zone,
	"last_enqueued_at" timestamp with time zone,
	"parent_conversation_id" text,
	"transcript_purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "junior_destinations" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_tenant_id" text DEFAULT '' NOT NULL,
	"provider_destination_id" text NOT NULL,
	"kind" text NOT NULL,
	"parent_destination_id" text,
	"display_name" text,
	"visibility" text DEFAULT 'unknown' NOT NULL,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "junior_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"provider_tenant_id" text DEFAULT '' NOT NULL,
	"provider_subject_id" text NOT NULL,
	"display_name" text,
	"handle" text,
	"email" text,
	"avatar_url" text,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"user_id" text,
	"email_normalized" text,
	"email_verified" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "junior_users" (
	"id" text PRIMARY KEY NOT NULL,
	"primary_email" text NOT NULL,
	"primary_email_normalized" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "junior_agent_steps" ADD CONSTRAINT "junior_agent_steps_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_conversation_messages" ADD CONSTRAINT "junior_conversation_messages_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_conversation_messages" ADD CONSTRAINT "junior_conversation_messages_author_identity_id_junior_identities_id_fk" FOREIGN KEY ("author_identity_id") REFERENCES "public"."junior_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_destination_id_junior_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."junior_destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_actor_identity_id_junior_identities_id_fk" FOREIGN KEY ("actor_identity_id") REFERENCES "public"."junior_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_creator_identity_id_junior_identities_id_fk" FOREIGN KEY ("creator_identity_id") REFERENCES "public"."junior_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_credential_subject_identity_id_junior_identities_id_fk" FOREIGN KEY ("credential_subject_identity_id") REFERENCES "public"."junior_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_parent_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("parent_conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_identities" ADD CONSTRAINT "junior_identities_user_id_junior_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."junior_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_agent_steps_epoch_idx" ON "junior_agent_steps" USING btree ("conversation_id","context_epoch","seq");--> statement-breakpoint
CREATE INDEX "junior_conversation_messages_activity_idx" ON "junior_conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "junior_conversations_last_activity_idx" ON "junior_conversations" USING btree ("last_activity_at" DESC NULLS LAST,"conversation_id");--> statement-breakpoint
CREATE INDEX "junior_conversations_active_idx" ON "junior_conversations" USING btree (coalesce("execution_updated_at", "updated_at"),"conversation_id") WHERE "junior_conversations"."execution_status" <> 'idle';--> statement-breakpoint
CREATE INDEX "junior_conversations_destination_activity_idx" ON "junior_conversations" USING btree ("destination_id","last_activity_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "junior_conversations_actor_activity_idx" ON "junior_conversations" USING btree ("actor_identity_id","last_activity_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "junior_conversations_origin_idx" ON "junior_conversations" USING btree ("origin_type","origin_id","last_activity_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "junior_conversations_parent_idx" ON "junior_conversations" USING btree ("parent_conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "junior_destinations_provider_destination_uidx" ON "junior_destinations" USING btree ("provider","provider_tenant_id","provider_destination_id");--> statement-breakpoint
CREATE INDEX "junior_destinations_provider_kind_idx" ON "junior_destinations" USING btree ("provider","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "junior_identities_provider_subject_uidx" ON "junior_identities" USING btree ("provider","provider_tenant_id","provider_subject_id");--> statement-breakpoint
CREATE INDEX "junior_identities_user_idx" ON "junior_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "junior_identities_verified_email_idx" ON "junior_identities" USING btree ("email_normalized") WHERE "junior_identities"."email_verified" = true AND "junior_identities"."email_normalized" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "junior_identities_kind_provider_idx" ON "junior_identities" USING btree ("kind","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "junior_users_primary_email_normalized_uidx" ON "junior_users" USING btree ("primary_email_normalized");