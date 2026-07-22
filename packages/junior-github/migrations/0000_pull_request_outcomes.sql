CREATE TABLE "junior_github_pull_requests" (
	"pull_request_id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"number" integer NOT NULL,
	"state" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "junior_github_pull_requests_repository_number_idx" ON "junior_github_pull_requests" USING btree ("repository_id","number");--> statement-breakpoint
CREATE INDEX "junior_github_pull_requests_opened_at_idx" ON "junior_github_pull_requests" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "junior_github_pull_requests_merged_at_idx" ON "junior_github_pull_requests" USING btree ("merged_at");--> statement-breakpoint
CREATE INDEX "junior_github_pull_requests_closed_at_idx" ON "junior_github_pull_requests" USING btree ("closed_at");--> statement-breakpoint
CREATE INDEX "junior_github_pull_requests_state_idx" ON "junior_github_pull_requests" USING btree ("state");
