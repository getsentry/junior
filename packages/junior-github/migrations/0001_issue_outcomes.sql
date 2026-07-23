CREATE TABLE "junior_github_issues" (
	"issue_id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"number" integer NOT NULL,
	"state" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "junior_github_issues_opened_at_idx" ON "junior_github_issues" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "junior_github_issues_closed_at_idx" ON "junior_github_issues" USING btree ("closed_at");--> statement-breakpoint
CREATE INDEX "junior_github_issues_open_idx" ON "junior_github_issues" USING btree ("issue_id") WHERE "junior_github_issues"."state" = 'open';
