ALTER TABLE "junior_workspaces" ADD COLUMN "snapshot_id" text;--> statement-breakpoint
ALTER TABLE "junior_workspaces" ADD COLUMN "snapshot_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "junior_workspaces" ADD COLUMN "snapshot_build_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "junior_workspaces" ADD COLUMN "snapshot_profile_hash" text;