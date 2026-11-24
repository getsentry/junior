CREATE TABLE "junior_location_configurations" (
	"location_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	"source" text,
	"expires_at" text,
	CONSTRAINT "junior_location_configurations_location_id_key_pk" PRIMARY KEY("location_id","key")
);
--> statement-breakpoint
ALTER TABLE "junior_location_configurations" ADD CONSTRAINT "junior_location_configurations_location_id_junior_destinations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."junior_destinations"("id") ON DELETE cascade ON UPDATE no action;
