ALTER TABLE "junior_github_pull_requests" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" ADD COLUMN "conflict_fixes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" ADD COLUMN "conflict_fixed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" ADD COLUMN "conflict_noticed_at" timestamp with time zone;