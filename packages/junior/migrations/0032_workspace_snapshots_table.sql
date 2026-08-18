CREATE TABLE "junior_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"profile_hash" text NOT NULL,
	"status" text NOT NULL,
	"snapshot_id" text,
	"build_duration_ms" integer,
	"generated_at" timestamp with time zone,
	"build_started_at" timestamp with time zone,
	"build_phase" text,
	"build_sandbox_name" text,
	"build_command_id" text,
	"build_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_snapshots_status_check" CHECK ("junior_snapshots"."status" in ('building', 'failed', 'ready')),
	CONSTRAINT "junior_snapshots_build_phase_check" CHECK ("junior_snapshots"."build_phase" is null or "junior_snapshots"."build_phase" in ('created', 'dependencies_installed', 'repositories_prepared')),
	CONSTRAINT "junior_snapshots_ready_fields_check" CHECK ("junior_snapshots"."status" <> 'ready' or ("junior_snapshots"."snapshot_id" is not null and "junior_snapshots"."build_duration_ms" is not null and "junior_snapshots"."generated_at" is not null)),
	CONSTRAINT "junior_snapshots_build_fields_check" CHECK ("junior_snapshots"."status" = 'ready' or ("junior_snapshots"."build_started_at" is not null and "junior_snapshots"."build_phase" is not null)),
	CONSTRAINT "junior_snapshots_build_duration_check" CHECK ("junior_snapshots"."build_duration_ms" is null or "junior_snapshots"."build_duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "junior_snapshots" ADD CONSTRAINT "junior_snapshots_workspace_id_junior_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."junior_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_snapshots_snapshot_id_uidx" ON "junior_snapshots" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "junior_snapshots_workspace_idx" ON "junior_snapshots" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "junior_snapshots_workspace_profile_status_idx" ON "junior_snapshots" USING btree ("workspace_id","profile_hash","status");--> statement-breakpoint
CREATE INDEX "junior_snapshots_workspace_status_idx" ON "junior_snapshots" USING btree ("workspace_id","status");--> statement-breakpoint
-- Move legacy recipe-column snapshot facts into junior_snapshots before drop.
INSERT INTO "junior_snapshots" (
	"id",
	"workspace_id",
	"profile_hash",
	"status",
	"snapshot_id",
	"build_duration_ms",
	"generated_at",
	"build_started_at",
	"build_phase",
	"build_sandbox_name",
	"build_command_id",
	"build_error",
	"created_at",
	"updated_at"
)
SELECT
	gen_random_uuid()::text,
	"id",
	"snapshot_profile_hash",
	'ready',
	"snapshot_id",
	"snapshot_build_duration_ms",
	"snapshot_generated_at",
	NULL,
	NULL,
	NULL,
	NULL,
	NULL,
	COALESCE("snapshot_generated_at", "updated_at", "created_at"),
	COALESCE("snapshot_generated_at", "updated_at", "created_at")
FROM "junior_workspaces"
WHERE
	"snapshot_id" IS NOT NULL
	AND "snapshot_profile_hash" IS NOT NULL
	AND "snapshot_generated_at" IS NOT NULL
	AND "snapshot_build_duration_ms" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_workspaces" DROP COLUMN "snapshot_id";--> statement-breakpoint
ALTER TABLE "junior_workspaces" DROP COLUMN "snapshot_generated_at";--> statement-breakpoint
ALTER TABLE "junior_workspaces" DROP COLUMN "snapshot_build_duration_ms";--> statement-breakpoint
ALTER TABLE "junior_workspaces" DROP COLUMN "snapshot_profile_hash";
