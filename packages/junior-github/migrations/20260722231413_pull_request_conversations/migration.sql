ALTER TABLE "junior_github_pull_requests" ADD COLUMN "conversation_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL;
