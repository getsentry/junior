CREATE TABLE "junior_sandbox_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"created_sandbox" boolean NOT NULL,
	"cost_usd" double precision,
	"check_after" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD COLUMN "sandbox_cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "junior_sandbox_sessions" ADD CONSTRAINT "junior_sandbox_sessions_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_sandbox_sessions_conversation_run_idx" ON "junior_sandbox_sessions" USING btree ("conversation_id","run_id");--> statement-breakpoint
CREATE INDEX "junior_sandbox_sessions_unsettled_check_after_idx" ON "junior_sandbox_sessions" USING btree ("check_after") WHERE "junior_sandbox_sessions"."settled_at" is null;