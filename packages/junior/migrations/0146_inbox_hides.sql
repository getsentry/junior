CREATE TABLE "junior_inbox_hides" (
	"user_id" text NOT NULL,
	"inbox_item_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_inbox_hides_user_id_inbox_item_id_pk" PRIMARY KEY("user_id","inbox_item_id")
);
--> statement-breakpoint
ALTER TABLE "junior_inbox_hides" ADD CONSTRAINT "junior_inbox_hides_user_id_junior_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."junior_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_inbox_hides" ADD CONSTRAINT "junior_inbox_hides_inbox_item_id_junior_inbox_items_id_fk" FOREIGN KEY ("inbox_item_id") REFERENCES "public"."junior_inbox_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_inbox_hides_inbox_item_idx" ON "junior_inbox_hides" USING btree ("inbox_item_id");