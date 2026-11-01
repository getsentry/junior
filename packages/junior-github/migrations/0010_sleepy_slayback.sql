ALTER TABLE "junior_github_pull_request_requesters" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" ADD COLUMN "ready_to_merge_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" ADD COLUMN "ready_sync_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" ADD COLUMN "ready_sync_id" integer;--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" ADD COLUMN "ready_sync_at" timestamp with time zone;