DROP INDEX "junior_artifacts_public_sha_uidx";--> statement-breakpoint
ALTER TABLE "junior_artifacts" ADD COLUMN "expires_at" timestamp with time zone;