CREATE TABLE "junior_google_accounts" (
	"account_email" text PRIMARY KEY NOT NULL,
	"refresh_token" text NOT NULL,
	"scope" text NOT NULL,
	"connected_by" text NOT NULL,
	"connected_at_ms" bigint NOT NULL
);
