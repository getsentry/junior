CREATE TABLE "junior_tool_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"input" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"credential_context" jsonb,
	"destination" jsonb NOT NULL,
	"approver_user_id" text NOT NULL,
	"review_item_id" text NOT NULL,
	"status" text NOT NULL,
	"run_turn_id" text,
	"result" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_tool_approvals_status_check" CHECK (("junior_tool_approvals"."status" in ('pending', 'declined') and "junior_tool_approvals"."run_turn_id" is null and "junior_tool_approvals"."result" is null) or ("junior_tool_approvals"."status" = 'running' and "junior_tool_approvals"."run_turn_id" is not null and "junior_tool_approvals"."result" is null) or ("junior_tool_approvals"."status" in ('completed', 'failed') and "junior_tool_approvals"."run_turn_id" is not null and "junior_tool_approvals"."result" is not null))
);
--> statement-breakpoint
ALTER TABLE "junior_tool_approvals" ADD CONSTRAINT "junior_tool_approvals_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_tool_approvals" ADD CONSTRAINT "junior_tool_approvals_approver_user_id_junior_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."junior_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_tool_approvals" ADD CONSTRAINT "junior_tool_approvals_review_item_id_junior_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."junior_review_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_tool_approvals_call_uidx" ON "junior_tool_approvals" USING btree ("conversation_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "junior_tool_approvals_conversation_idx" ON "junior_tool_approvals" USING btree ("conversation_id","status");