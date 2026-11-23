CREATE TABLE "junior_plugin_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin" text NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_plugin_tasks_status_check" CHECK ("junior_plugin_tasks"."status" in ('pending', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "junior_plugin_tasks_plugin_key_uidx" ON "junior_plugin_tasks" USING btree ("plugin","key");--> statement-breakpoint
CREATE INDEX "junior_plugin_tasks_open_lease_idx" ON "junior_plugin_tasks" USING btree ("lease_expires_at") WHERE "junior_plugin_tasks"."status" in ('pending', 'running');