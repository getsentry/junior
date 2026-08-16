ALTER TABLE "junior_workspaces" ADD COLUMN "snapshot_status" text;--> statement-breakpoint
ALTER TABLE "junior_workspaces" ADD COLUMN "snapshot_build_profile_hash" text;--> statement-breakpoint
ALTER TABLE "junior_workspaces" ADD COLUMN "snapshot_build_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "junior_workspaces" ADD COLUMN "snapshot_build_sandbox_name" text;--> statement-breakpoint
ALTER TABLE "junior_workspaces" ADD COLUMN "snapshot_build_command_id" text;--> statement-breakpoint
ALTER TABLE "junior_workspaces" ADD COLUMN "snapshot_build_error" text;