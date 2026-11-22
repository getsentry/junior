DROP INDEX "junior_github_pull_requests_merged_at_idx";--> statement-breakpoint
DROP INDEX "junior_github_pull_requests_closed_at_idx";--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" DROP COLUMN "draft";--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" DROP COLUMN "merged_at";--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" DROP COLUMN "closed_at";