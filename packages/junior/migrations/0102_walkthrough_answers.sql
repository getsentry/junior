CREATE TABLE "junior_walkthrough_answers" (
	"version_id" uuid NOT NULL,
	"decision_id" text NOT NULL,
	"user_id" text NOT NULL,
	"value" text NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_walkthrough_answers_pk" PRIMARY KEY("version_id","user_id","decision_id")
);
--> statement-breakpoint
ALTER TABLE "junior_walkthrough_answers" ADD CONSTRAINT "junior_walkthrough_answers_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."junior_walkthrough_versions"("id") ON DELETE cascade ON UPDATE no action;