CREATE TABLE "junior_push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "junior_users" ADD COLUMN "notification_schedule" jsonb;--> statement-breakpoint
ALTER TABLE "junior_push_subscriptions" ADD CONSTRAINT "junior_push_subscriptions_user_id_junior_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."junior_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_push_subscriptions_endpoint_uidx" ON "junior_push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "junior_push_subscriptions_user_idx" ON "junior_push_subscriptions" USING btree ("user_id");