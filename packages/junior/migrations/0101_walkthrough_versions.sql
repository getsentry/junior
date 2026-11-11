CREATE TABLE "junior_walkthrough_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_version_id" uuid,
	"provider" text NOT NULL,
	"repository" text NOT NULL,
	"snapshot_key" text NOT NULL,
	"code_changes" jsonb NOT NULL,
	"generation_conversation_id" text,
	"source_conversation_id" text,
	"status" text NOT NULL,
	"document_key" text,
	"failure_reason" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "junior_walkthrough_versions_snapshot_idx" ON "junior_walkthrough_versions" USING btree ("provider","repository","snapshot_key") WHERE "junior_walkthrough_versions"."status" <> 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX "junior_walkthrough_versions_generation_conversation_idx" ON "junior_walkthrough_versions" USING btree ("generation_conversation_id");--> statement-breakpoint
CREATE INDEX "junior_walkthrough_versions_parent_idx" ON "junior_walkthrough_versions" USING btree ("parent_version_id");