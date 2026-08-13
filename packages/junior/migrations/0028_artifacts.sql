CREATE TABLE "junior_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"sha256" text NOT NULL,
	"ext" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"public" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"delete_requested_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "junior_artifacts_conversation_sha_uidx" ON "junior_artifacts" USING btree ("conversation_id","sha256");--> statement-breakpoint
CREATE INDEX "junior_artifacts_gc_idx" ON "junior_artifacts" USING btree ("delete_requested_at","created_at");--> statement-breakpoint
CREATE INDEX "junior_artifacts_conversation_idx" ON "junior_artifacts" USING btree ("conversation_id");