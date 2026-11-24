CREATE TABLE "junior_workspace_repos" (
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"repo" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "junior_workspace_repos_workspace_id_provider_repo_pk" PRIMARY KEY("workspace_id","provider","repo")
);
--> statement-breakpoint
CREATE TABLE "junior_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"setup_script" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "junior_workspace_repos" ADD CONSTRAINT "junior_workspace_repos_workspace_id_junior_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."junior_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_workspace_repos_primary_idx" ON "junior_workspace_repos" USING btree ("workspace_id") WHERE "junior_workspace_repos"."is_primary";--> statement-breakpoint
CREATE UNIQUE INDEX "junior_workspaces_name_idx" ON "junior_workspaces" USING btree ("name");