ALTER TABLE "junior_github_pull_requests" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
-- junior:bounded-backfill: the table holds only pull requests that Junior opened, a few thousand rows, and each row changes once.
UPDATE "junior_github_pull_requests" SET "finished_at" = coalesce("merged_at", "closed_at") WHERE "state" <> 'open';
