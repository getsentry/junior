CREATE TABLE "junior_conversation_briefs" (
	"conversation_id" text NOT NULL,
	"version" integer NOT NULL,
	"turn_id" text NOT NULL,
	"through_seq" integer NOT NULL,
	"content" jsonb NOT NULL,
	"search_text" text NOT NULL,
	"model_id" text NOT NULL,
	"cost_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "junior_conversation_briefs_conversation_id_version_pk" PRIMARY KEY("conversation_id","version")
);
--> statement-breakpoint
ALTER TABLE "junior_conversation_briefs" ADD CONSTRAINT "junior_conversation_briefs_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_conversation_briefs_conversation_turn_idx" ON "junior_conversation_briefs" USING btree ("conversation_id","turn_id");--> statement-breakpoint
CREATE INDEX "junior_conversation_briefs_conversation_version_idx" ON "junior_conversation_briefs" USING btree ("conversation_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "junior_conversation_briefs_search_idx" ON "junior_conversation_briefs" USING gin (to_tsvector('english', "search_text"));