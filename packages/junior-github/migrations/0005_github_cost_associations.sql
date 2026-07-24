ALTER TABLE "junior_github_issues" ADD COLUMN "conversation_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" ADD COLUMN "linked_issue_numbers" integer[] DEFAULT ARRAY[]::integer[] NOT NULL;
