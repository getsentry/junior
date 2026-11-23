CREATE TABLE "junior_github_issue_reviewers" (
	"repository_full_name" text NOT NULL,
	"number" integer NOT NULL,
	"login" text NOT NULL,
	"conversation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone,
	CONSTRAINT "junior_github_issue_reviewers_repository_full_name_number_login_pk" PRIMARY KEY("repository_full_name","number","login")
);
