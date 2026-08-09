CREATE TABLE "junior_destination_configurations" (
	"destination_key" text PRIMARY KEY NOT NULL,
	"configuration_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
