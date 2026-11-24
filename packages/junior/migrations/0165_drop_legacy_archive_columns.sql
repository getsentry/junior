-- 0158_keep_legacy_archive_columns removed these from the snapshot and kept
-- them in the database for one release.
ALTER TABLE "junior_conversation_participants" DROP COLUMN IF EXISTS "archived_at";--> statement-breakpoint
ALTER TABLE "junior_conversations" DROP COLUMN IF EXISTS "child_archived_at";
