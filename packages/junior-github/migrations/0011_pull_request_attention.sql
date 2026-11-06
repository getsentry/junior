ALTER TABLE "junior_github_pull_requests" ADD COLUMN "checks_head_sha" text;--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" ADD COLUMN "failing_check_suite_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" ADD COLUMN "changes_requested_by" text[] DEFAULT ARRAY[]::text[] NOT NULL;