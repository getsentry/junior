DROP INDEX "junior_github_pull_requests_opened_at_idx";--> statement-breakpoint
DROP INDEX "junior_github_pull_requests_open_idx";--> statement-breakpoint
DROP INDEX "junior_github_pull_requests_unmerged_conversations_idx";--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" DROP COLUMN "repository_id";--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" DROP COLUMN "repository_full_name";--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" DROP COLUMN "number";--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" DROP COLUMN "state";--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" DROP COLUMN "conversation_ids";--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" DROP COLUMN "opened_at";--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" DROP COLUMN "finished_at";