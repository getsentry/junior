CREATE TABLE "junior_inbox_snooze_triggers" (
	"snooze_id" text NOT NULL,
	"outcome" text NOT NULL,
	"namespace" text NOT NULL,
	"identifier" text NOT NULL,
	"event_type" text NOT NULL,
	"match" jsonb,
	CONSTRAINT "junior_inbox_snooze_triggers_outcome_check" CHECK ("junior_inbox_snooze_triggers"."outcome" in ('wake', 'resolve'))
);
--> statement-breakpoint
CREATE TABLE "junior_inbox_snoozes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"review_item_id" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_inbox_snoozes_state_check" CHECK ("junior_inbox_snoozes"."state" in ('snoozed', 'woken', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "junior_inbox_snooze_triggers" ADD CONSTRAINT "junior_inbox_snooze_triggers_snooze_id_junior_inbox_snoozes_id_fk" FOREIGN KEY ("snooze_id") REFERENCES "public"."junior_inbox_snoozes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_inbox_snoozes" ADD CONSTRAINT "junior_inbox_snoozes_user_id_junior_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."junior_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_inbox_snoozes" ADD CONSTRAINT "junior_inbox_snoozes_review_item_id_junior_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."junior_review_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_inbox_snooze_triggers_event_idx" ON "junior_inbox_snooze_triggers" USING btree ("namespace","identifier","event_type");--> statement-breakpoint
CREATE INDEX "junior_inbox_snooze_triggers_snooze_idx" ON "junior_inbox_snooze_triggers" USING btree ("snooze_id");--> statement-breakpoint
CREATE UNIQUE INDEX "junior_inbox_snoozes_snoozed_uidx" ON "junior_inbox_snoozes" USING btree ("user_id","review_item_id") WHERE "junior_inbox_snoozes"."state" = 'snoozed';--> statement-breakpoint
CREATE INDEX "junior_inbox_snoozes_settled_idx" ON "junior_inbox_snoozes" USING btree ("created_at") WHERE "junior_inbox_snoozes"."state" <> 'snoozed';--> statement-breakpoint
CREATE INDEX "junior_inbox_snoozes_review_item_idx" ON "junior_inbox_snoozes" USING btree ("review_item_id");