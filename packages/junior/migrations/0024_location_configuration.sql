CREATE TABLE "junior_location_configurations" (
	"location_id" text PRIMARY KEY NOT NULL,
	"configuration_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "junior_location_configurations" ADD CONSTRAINT "junior_location_configurations_location_id_junior_destinations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."junior_destinations"("id") ON DELETE cascade ON UPDATE no action;