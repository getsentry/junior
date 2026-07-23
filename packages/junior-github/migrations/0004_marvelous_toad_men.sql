ALTER TABLE "junior_github_issues" ADD COLUMN "state_reason" text;
--> statement-breakpoint
UPDATE "junior_github_issues"
SET "state_reason" = 'completed'
WHERE "state" = 'closed';