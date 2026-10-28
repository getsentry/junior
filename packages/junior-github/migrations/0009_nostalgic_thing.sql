CREATE TABLE "junior_github_pull_request_requesters" (
	"repository_full_name" text NOT NULL,
	"number" integer,
	"head_branch" text,
	"identity_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "junior_github_pull_request_requesters_number_uidx" ON "junior_github_pull_request_requesters" USING btree ("repository_full_name","number","identity_id") WHERE "junior_github_pull_request_requesters"."number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_github_pull_request_requesters_pending_uidx" ON "junior_github_pull_request_requesters" USING btree ("repository_full_name","head_branch","identity_id") WHERE "junior_github_pull_request_requesters"."number" IS NULL;