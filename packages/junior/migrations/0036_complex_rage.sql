CREATE TABLE "junior_code_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"closed_at" timestamp with time zone,
	"conversation_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"merged_at" timestamp with time zone,
	"number" integer NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"repository_id" uuid NOT NULL,
	"state" text NOT NULL,
	"title" text,
	"updated_at" timestamp with time zone NOT NULL,
	"url" text
);
--> statement-breakpoint
CREATE TABLE "junior_code_repositories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"url" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "junior_code_changes" ADD CONSTRAINT "junior_code_changes_repository_id_junior_code_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."junior_code_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_code_changes_provider_id_idx" ON "junior_code_changes" USING btree ("provider","provider_id");--> statement-breakpoint
CREATE INDEX "junior_code_changes_opened_at_idx" ON "junior_code_changes" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "junior_code_changes_merged_at_idx" ON "junior_code_changes" USING btree ("merged_at");--> statement-breakpoint
CREATE INDEX "junior_code_changes_closed_at_idx" ON "junior_code_changes" USING btree ("closed_at");--> statement-breakpoint
CREATE INDEX "junior_code_changes_open_idx" ON "junior_code_changes" USING btree ("id") WHERE "junior_code_changes"."state" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "junior_code_repositories_provider_id_idx" ON "junior_code_repositories" USING btree ("provider","provider_id");
