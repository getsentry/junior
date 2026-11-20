CREATE TABLE "junior_github_pull_request_requesters" (
	"repository_full_name" text NOT NULL,
	"number" integer NOT NULL,
	"identity_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_github_pull_request_requesters_repository_full_name_number_identity_id_pk" PRIMARY KEY("repository_full_name","number","identity_id")
);
