CREATE TABLE "junior_github_pull_request_requesters" (
	"repository_full_name" text NOT NULL,
	"head_branch" text NOT NULL,
	"requester_login" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_github_pull_request_requesters_repository_full_name_head_branch_pk" PRIMARY KEY("repository_full_name","head_branch")
);
