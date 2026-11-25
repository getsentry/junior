-- 0124 and 0125 (Junior 0.310.0) moved every reader and writer to
-- `visibility` and the public-row index. This drops what only older runtimes
-- used. A host that upgrades from before 0.310.0 straight past this release
-- fails image publishes and public artifact reads until the new runtime serves.
DROP INDEX "junior_artifacts_conversation_sha_uidx";--> statement-breakpoint
-- A write that omits `visibility` gets the narrowest audience, never public.
ALTER TABLE "junior_artifacts" ALTER COLUMN "visibility" SET DEFAULT 'conversation';--> statement-breakpoint
ALTER TABLE "junior_artifacts" DROP COLUMN "public";
