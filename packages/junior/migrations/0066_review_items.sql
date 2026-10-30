CREATE TABLE "junior_review_item_assignees" (
	"item_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "junior_review_item_assignees_item_id_user_id_pk" PRIMARY KEY("item_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "junior_review_item_conversations" (
	"item_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	CONSTRAINT "junior_review_item_conversations_item_id_conversation_id_pk" PRIMARY KEY("item_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "junior_review_items" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"visibility" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"request" jsonb,
	"answer" jsonb,
	"assigned_to_everyone" boolean DEFAULT false NOT NULL,
	"dedupe_key" text NOT NULL,
	"subject_id" text,
	"subject_title" text,
	"subject_url" text,
	"added_by_conversation_id" text NOT NULL,
	"automation_id" text,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" text,
	"close_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_review_items_kind_check" CHECK (("junior_review_items"."kind" = 'notice' and "junior_review_items"."request" is null and "junior_review_items"."answer" is null) or ("junior_review_items"."kind" = 'action' and "junior_review_items"."request" is not null)),
	CONSTRAINT "junior_review_items_status_check" CHECK (("junior_review_items"."status" = 'open' and "junior_review_items"."closed_at" is null) or ("junior_review_items"."status" in ('done', 'dismissed') and "junior_review_items"."closed_at" is not null)),
	CONSTRAINT "junior_review_items_visibility_check" CHECK ("junior_review_items"."visibility" = 'public' or not "junior_review_items"."assigned_to_everyone")
);
--> statement-breakpoint
ALTER TABLE "junior_review_item_assignees" ADD CONSTRAINT "junior_review_item_assignees_item_id_junior_review_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."junior_review_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_review_item_assignees" ADD CONSTRAINT "junior_review_item_assignees_user_id_junior_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."junior_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_review_item_conversations" ADD CONSTRAINT "junior_review_item_conversations_item_id_junior_review_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."junior_review_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_review_item_conversations" ADD CONSTRAINT "junior_review_item_conversations_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_review_items" ADD CONSTRAINT "junior_review_items_automation_id_junior_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."junior_automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_review_items" ADD CONSTRAINT "junior_review_items_closed_by_user_id_junior_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."junior_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_review_item_assignees_user_idx" ON "junior_review_item_assignees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "junior_review_item_conversations_conversation_idx" ON "junior_review_item_conversations" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "junior_review_items_open_dedupe_uidx" ON "junior_review_items" USING btree ("dedupe_key") WHERE "junior_review_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX "junior_review_items_status_idx" ON "junior_review_items" USING btree ("status","updated_at","id");--> statement-breakpoint
CREATE INDEX "junior_review_items_subject_idx" ON "junior_review_items" USING btree ("subject_id","status");--> statement-breakpoint
CREATE INDEX "junior_review_items_automation_idx" ON "junior_review_items" USING btree ("automation_id","status");