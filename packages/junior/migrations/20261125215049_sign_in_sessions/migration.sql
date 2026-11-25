CREATE TABLE "junior_sign_in_sessions" (
	"id" text PRIMARY KEY,
	"token_hash" text NOT NULL,
	"user_email_normalized" text NOT NULL,
	"user_name" text,
	"client" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "junior_sign_in_sessions_token_hash_uidx" ON "junior_sign_in_sessions" ("token_hash");--> statement-breakpoint
CREATE INDEX "junior_sign_in_sessions_user_email_idx" ON "junior_sign_in_sessions" ("user_email_normalized");