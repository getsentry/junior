-- `ready_to_merge_at` stays for one release, so workers from before this
-- migration keep working during the rollout. A later migration drops it.
ALTER TABLE "junior_github_pull_requests" ADD COLUMN "next_action" text;--> statement-breakpoint
-- junior:bounded-backfill: only open Junior pull requests that are ready to merge have ready_to_merge_at set.
UPDATE "junior_github_pull_requests" SET "next_action" = 'merge' WHERE "ready_to_merge_at" IS NOT NULL;
