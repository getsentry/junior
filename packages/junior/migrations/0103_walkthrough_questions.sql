CREATE TABLE "junior_walkthrough_questions" (
	"version_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_walkthrough_questions_pk" PRIMARY KEY("version_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "junior_walkthrough_questions" ADD CONSTRAINT "junior_walkthrough_questions_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."junior_walkthrough_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_walkthrough_questions_conversation_idx" ON "junior_walkthrough_questions" USING btree ("conversation_id");