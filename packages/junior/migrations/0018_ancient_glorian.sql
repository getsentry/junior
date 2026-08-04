CREATE TABLE "junior_conversation_bindings" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_tenant_id" text DEFAULT '' NOT NULL,
	"provider_destination_id" text NOT NULL,
	"provider_thread_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "junior_conversation_bindings" ADD CONSTRAINT "junior_conversation_bindings_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_conversation_bindings_provider_thread_uidx" ON "junior_conversation_bindings" USING btree ("provider","provider_tenant_id","provider_destination_id","provider_thread_id");--> statement-breakpoint
CREATE INDEX "junior_conversation_bindings_destination_idx" ON "junior_conversation_bindings" USING btree ("provider","provider_tenant_id","provider_destination_id");