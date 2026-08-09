CREATE TABLE "junior_channel_configurations" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"configuration_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
