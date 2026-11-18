CREATE TABLE "junior_inbox_snooze_triggers" (
	"snooze_id" text NOT NULL,
	"outcome" text NOT NULL,
	"namespace" text NOT NULL,
	"identifier" text,
	"event_type" text NOT NULL,
	"match" jsonb,
	CONSTRAINT "junior_inbox_snooze_triggers_outcome_check" CHECK ("junior_inbox_snooze_triggers"."outcome" in ('wake', 'resolve'))
);
--> statement-breakpoint
CREATE TABLE "junior_inbox_snoozes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"review_item_id" text,
	"wake_at_ms" bigint NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_inbox_snoozes_status_check" CHECK ("junior_inbox_snoozes"."status" in ('active', 'woken', 'resolved', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "junior_inbox_snooze_triggers" ADD CONSTRAINT "junior_inbox_snooze_triggers_snooze_id_junior_inbox_snoozes_id_fk" FOREIGN KEY ("snooze_id") REFERENCES "public"."junior_inbox_snoozes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_inbox_snoozes" ADD CONSTRAINT "junior_inbox_snoozes_user_id_junior_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."junior_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_inbox_snoozes" ADD CONSTRAINT "junior_inbox_snoozes_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_inbox_snoozes" ADD CONSTRAINT "junior_inbox_snoozes_review_item_id_junior_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."junior_review_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_inbox_snooze_triggers_event_idx" ON "junior_inbox_snooze_triggers" USING btree ("namespace","identifier","event_type");--> statement-breakpoint
CREATE INDEX "junior_inbox_snooze_triggers_snooze_idx" ON "junior_inbox_snooze_triggers" USING btree ("snooze_id");--> statement-breakpoint
CREATE UNIQUE INDEX "junior_inbox_snoozes_active_row_uidx" ON "junior_inbox_snoozes" USING btree ("user_id","conversation_id",coalesce("review_item_id", '')) WHERE "junior_inbox_snoozes"."status" = 'active';--> statement-breakpoint
CREATE INDEX "junior_inbox_snoozes_due_idx" ON "junior_inbox_snoozes" USING btree ("wake_at_ms") WHERE "junior_inbox_snoozes"."status" = 'active';--> statement-breakpoint
CREATE INDEX "junior_inbox_snoozes_settled_idx" ON "junior_inbox_snoozes" USING btree ("created_at") WHERE "junior_inbox_snoozes"."status" <> 'active';--> statement-breakpoint
CREATE INDEX "junior_inbox_snoozes_conversation_idx" ON "junior_inbox_snoozes" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "junior_inbox_snoozes_review_item_idx" ON "junior_inbox_snoozes" USING btree ("review_item_id") WHERE "junior_inbox_snoozes"."review_item_id" is not null;