CREATE TABLE "junior_github_conflict_checks" (
	"repository_full_name" text PRIMARY KEY NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "junior_github_conflict_checks_due_at_idx" ON "junior_github_conflict_checks" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "junior_github_pull_requests_open_repository_idx" ON "junior_github_pull_requests" USING btree ("repository_full_name") WHERE "junior_github_pull_requests"."state" = 'open';