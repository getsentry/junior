CREATE TABLE "junior_github_pull_request_issues" (
	"pull_request_id" text NOT NULL,
	"issue_id" text NOT NULL,
	CONSTRAINT "junior_github_pull_request_issues_pull_request_id_issue_id_pk" PRIMARY KEY("pull_request_id","issue_id")
);
--> statement-breakpoint
ALTER TABLE "junior_github_pull_request_issues" ADD CONSTRAINT "junior_github_pull_request_issues_pull_request_id_junior_github_pull_requests_pull_request_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."junior_github_pull_requests"("pull_request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_github_pull_request_issues" ADD CONSTRAINT "junior_github_pull_request_issues_issue_id_junior_github_issues_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."junior_github_issues"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_github_pull_requests" DROP COLUMN "linked_issue_numbers";