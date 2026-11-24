CREATE TABLE "junior_inbox_item_deliveries" (
	"item_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"event" text NOT NULL,
	"status" text NOT NULL,
	"skip_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_inbox_item_deliveries_item_id_user_id_channel_event_pk" PRIMARY KEY("item_id","user_id","channel","event")
);
--> statement-breakpoint
ALTER TABLE "junior_inbox_item_deliveries" ADD CONSTRAINT "junior_inbox_item_deliveries_item_id_junior_inbox_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."junior_inbox_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_inbox_item_deliveries" ADD CONSTRAINT "junior_inbox_item_deliveries_user_id_junior_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."junior_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_inbox_item_deliveries_user_status_idx" ON "junior_inbox_item_deliveries" USING btree ("user_id","status","updated_at");