CREATE SEQUENCE "public"."junior_plan_item_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "junior_plan_items" (
	"conversation_id" text NOT NULL,
	"id" bigint NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"status" text NOT NULL,
	"assignee_conversation_id" text,
	"assignee_user_id" text,
	"version" bigint NOT NULL,
	"changed_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_plan_items_pk" PRIMARY KEY("conversation_id","id"),
	CONSTRAINT "junior_plan_items_status_check" CHECK ("junior_plan_items"."status" in ('pending', 'in_progress', 'blocked', 'done', 'cancelled')),
	CONSTRAINT "junior_plan_items_assignee_check" CHECK (("junior_plan_items"."assignee_conversation_id" is null) <> ("junior_plan_items"."assignee_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "junior_plan_items" ADD CONSTRAINT "junior_plan_items_assignee_user_id_junior_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."junior_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_plan_items" ADD CONSTRAINT "junior_plan_items_changed_by_user_id_junior_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."junior_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_plan_items" ADD CONSTRAINT "junior_plan_items_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_plan_items_in_progress_uidx" ON "junior_plan_items" USING btree ("conversation_id",coalesce("assignee_conversation_id", "assignee_user_id")) WHERE "junior_plan_items"."status" = 'in_progress';