CREATE TABLE "junior_github_installations" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"account_login" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_github_installations_account_login_unique" UNIQUE("account_login")
);
