CREATE TABLE "junior_api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_email_normalized" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_suffix" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "junior_api_tokens_token_hash_uidx" ON "junior_api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "junior_api_tokens_owner_email_idx" ON "junior_api_tokens" USING btree ("owner_email_normalized");